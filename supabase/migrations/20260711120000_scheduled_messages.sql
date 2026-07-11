-- Wait/delay support for messaging automations.
--
-- Each action (a messaging_rules row) can now send some minutes AFTER the
-- trigger instead of immediately. Delayed actions are enqueued into
-- scheduled_messages; a per-minute dispatcher (the dispatch-scheduled-messages
-- edge function, invoked by pg_cron) sends the ones that are due via Twilio.
-- Immediate actions (delay 0) still send inline and never touch this table.

ALTER TABLE public.messaging_rules
  ADD COLUMN IF NOT EXISTS delay_minutes integer NOT NULL DEFAULT 0;

-- Guard: 0 (immediate) up to 30 days out.
ALTER TABLE public.messaging_rules
  DROP CONSTRAINT IF EXISTS messaging_rules_delay_minutes_check;
ALTER TABLE public.messaging_rules
  ADD CONSTRAINT messaging_rules_delay_minutes_check
  CHECK (delay_minutes >= 0 AND delay_minutes <= 43200);

-- The queue of messages waiting for their send_at.
CREATE TABLE IF NOT EXISTS public.scheduled_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid REFERENCES public.messaging_rules(id) ON DELETE SET NULL,
  to_phone text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('sms', 'whatsapp')),
  -- Snapshot of what to send, rendered at enqueue time (so edits to the rule
  -- afterwards do not rewrite already-scheduled messages).
  body text,
  whatsapp_content_sid text,
  whatsapp_variables jsonb,
  -- Link fields, mirrored into sms_messages when the send happens.
  business_id uuid,
  booking_id uuid,
  customer_id uuid,
  tag text,
  send_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'canceled')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  provider_sid text,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  sent_at timestamptz,
  CHECK (channel <> 'sms' OR body IS NOT NULL),
  CHECK (channel <> 'whatsapp' OR whatsapp_content_sid IS NOT NULL)
);

-- Dispatcher lookup: only pending rows, ordered by when they are due.
CREATE INDEX IF NOT EXISTS scheduled_messages_due_idx
  ON public.scheduled_messages (send_at)
  WHERE status = 'pending';

DROP TRIGGER IF EXISTS set_scheduled_messages_updated_at ON public.scheduled_messages;
CREATE TRIGGER set_scheduled_messages_updated_at
BEFORE UPDATE ON public.scheduled_messages
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.scheduled_messages ENABLE ROW LEVEL SECURITY;

-- Owner can view the queue (for a future "scheduled" dashboard). All writes go
-- through the service role (enqueue in the app, claim/send in the edge
-- function), which bypasses RLS, so there is no write policy on purpose.
DROP POLICY IF EXISTS "scheduled_messages_select" ON public.scheduled_messages;
CREATE POLICY "scheduled_messages_select"
ON public.scheduled_messages
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM current_staff() cs(staff_id, role, business_id)
    WHERE cs.role = 'owner'::staff_role
  )
);

-- Atomically claim up to `batch` due messages for the dispatcher: flips them to
-- 'sending' and bumps attempts, using FOR UPDATE SKIP LOCKED so two concurrent
-- dispatcher runs never grab the same row (no double-send). SECURITY DEFINER so
-- the edge function can call it via RPC; only the service role should reach it.
CREATE OR REPLACE FUNCTION public.claim_due_scheduled_messages(batch integer DEFAULT 50)
RETURNS SETOF public.scheduled_messages
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.scheduled_messages
  SET status = 'sending', attempts = attempts + 1
  WHERE id IN (
    SELECT id
    FROM public.scheduled_messages
    WHERE status = 'pending'
      AND send_at <= timezone('utc', now())
    ORDER BY send_at
    LIMIT batch
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
$$;

REVOKE ALL ON FUNCTION public.claim_due_scheduled_messages(integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_scheduled_messages(integer) TO service_role;
