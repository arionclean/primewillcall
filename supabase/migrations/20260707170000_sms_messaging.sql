-- SMS messaging (Twilio): message log, opt-out registry, chat support.
-- Supabase-native replacement for Xano's message_historial + STOP handling.
-- Follows the whatsapp_messages house style: business/customer/booking links,
-- sent_by_staff_id, current_staff() RLS. Written by the service role only.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'sms_direction'
  ) THEN
    CREATE TYPE public.sms_direction AS ENUM ('inbound', 'outbound');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.sms_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  direction public.sms_direction NOT NULL,
  from_phone text NOT NULL,
  to_phone text NOT NULL,
  body text NOT NULL,
  tag text,
  status text,
  twilio_sid text,
  error text,
  business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  booking_id uuid REFERENCES public.bookings(id) ON DELETE SET NULL,
  sent_by_staff_id uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS sms_messages_to_phone_idx ON public.sms_messages (to_phone);
CREATE INDEX IF NOT EXISTS sms_messages_from_phone_idx ON public.sms_messages (from_phone);
CREATE INDEX IF NOT EXISTS sms_messages_created_at_idx ON public.sms_messages (created_at DESC);

-- Dedupe key so syncing from the Twilio Messages API can upsert without
-- duplicating rows already logged by the webhook or by our own sends.
-- Plain unique index: NULL sids (failed sends) do not conflict.
CREATE UNIQUE INDEX IF NOT EXISTS sms_messages_twilio_sid_key
ON public.sms_messages (twilio_sid);

-- Inbound messages are linked to customers by phone.
CREATE INDEX IF NOT EXISTS customers_phone_idx ON public.customers (phone);

CREATE TABLE IF NOT EXISTS public.sms_opt_outs (
  phone_number text PRIMARY KEY,
  opted_out boolean NOT NULL DEFAULT true,
  reason text,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

DROP TRIGGER IF EXISTS set_sms_opt_outs_updated_at ON public.sms_opt_outs;
CREATE TRIGGER set_sms_opt_outs_updated_at
BEFORE UPDATE ON public.sms_opt_outs
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.sms_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_opt_outs ENABLE ROW LEVEL SECURITY;

-- No insert/update/delete policies: only the service role (API routes) writes.
-- Read access mirrors whatsapp_messages: owners see everything (including
-- rows not yet linked to a business), business staff see their business.

DROP POLICY IF EXISTS "sms_messages_select" ON public.sms_messages;
CREATE POLICY "sms_messages_select"
ON public.sms_messages
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM current_staff() cs(staff_id, role, business_id)
    WHERE cs.role = 'owner'::staff_role OR cs.business_id = sms_messages.business_id
  )
);

DROP POLICY IF EXISTS "sms_opt_outs_select" ON public.sms_opt_outs;
CREATE POLICY "sms_opt_outs_select"
ON public.sms_opt_outs
FOR SELECT
TO authenticated
USING (EXISTS (SELECT 1 FROM current_staff()));

-- Stream inserts to the chat UI via Supabase Realtime (RLS still applies).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1
       FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'sms_messages'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.sms_messages;
  END IF;
END
$$;

-- One row per customer phone number with the latest message.
-- SECURITY INVOKER (default): callers only see rows their RLS policies allow.
CREATE OR REPLACE FUNCTION public.sms_conversations()
RETURNS TABLE (
  counterpart text,
  last_body text,
  last_direction public.sms_direction,
  last_at timestamptz,
  message_count bigint
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH scoped AS (
    SELECT
      CASE WHEN direction = 'inbound' THEN from_phone ELSE to_phone END AS counterpart,
      body,
      direction,
      created_at
    FROM public.sms_messages
  )
  SELECT DISTINCT ON (counterpart)
    counterpart,
    body AS last_body,
    direction AS last_direction,
    created_at AS last_at,
    COUNT(*) OVER (PARTITION BY counterpart) AS message_count
  FROM scoped
  ORDER BY counterpart, created_at DESC
$$;
