-- booking_sync_log: every booking record that arrives from outside, and what we did with it.
--
-- On 2026-09-22 a kiosk build started posting the departure as a display string the sync
-- does not accept. Each record was refused, the function answered 200 with the refusal
-- inside the body, the tablet read the 200 as success and printed the guest's ticket. Two
-- paying guests existed on no manifest and nothing anywhere recorded that it had happened;
-- the only reason we found out is that the owner noticed a ticket for a booking he could
-- not see. The pax and departure of one of them were never recoverable.
--
-- So every record the sync handles is written here, refused or not, with the raw payload.
-- A refusal is now visible, and a booking that later needs explaining (what did the tablet
-- actually send? when did it arrive? was it an echo or the first write?) can be read back.
--
-- This is a log, not a source of truth: nothing reads it to make a decision, and the sync
-- never fails because a log row could not be written.

CREATE TABLE IF NOT EXISTS public.booking_sync_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  -- Who posted it: 'kiosk' (the tablet, through kiosk-booking) or 'xano' (Xano's own
  -- trigger, and anything else replaying a Xano record).
  source      text NOT NULL DEFAULT 'xano',
  -- What the sync keyed it on, and Xano's own id for the row, when it had them.
  legacy_id   text,
  internal_id text,
  ok          boolean NOT NULL,
  -- What actually happened: inserted (first time we saw it), updated (a record we already
  -- held), echo (a booking born here coming back from Xano), refused (ok = false).
  action      text NOT NULL,
  error       text,
  booking_id  uuid,
  -- The record exactly as it arrived. This is what lets a lost booking be rebuilt.
  payload     jsonb NOT NULL
);

-- Reading it is always "the last N", or "this one booking's history".
CREATE INDEX IF NOT EXISTS booking_sync_log_at_idx ON public.booking_sync_log (at DESC);
CREATE INDEX IF NOT EXISTS booking_sync_log_legacy_idx ON public.booking_sync_log (legacy_id, at DESC);
-- The rows worth an alert: every refusal, newest first.
CREATE INDEX IF NOT EXISTS booking_sync_log_failed_idx ON public.booking_sync_log (at DESC) WHERE NOT ok;

ALTER TABLE public.booking_sync_log ENABLE ROW LEVEL SECURITY;

-- Owner only. The payload carries guest names and phones from every business, so a
-- manager must not read it. The sync writes with the service role and bypasses this.
DROP POLICY IF EXISTS booking_sync_log_owner_read ON public.booking_sync_log;
CREATE POLICY booking_sync_log_owner_read ON public.booking_sync_log
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'));

-- Keep 90 days. At about 600 records a day that is well under 100 MB, and it is long
-- enough to explain a booking someone asks about a season later.
CREATE OR REPLACE FUNCTION public.prune_booking_sync_log()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  v_deleted integer;
begin
  delete from public.booking_sync_log where at < now() - interval '90 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

REVOKE ALL ON FUNCTION public.prune_booking_sync_log() FROM public, anon, authenticated;

-- 08:45 UTC, just after the analytics rebuild, so the quiet hour does one thing at a time.
SELECT cron.schedule(
  'prune-booking-sync-log',
  '45 8 * * *',
  $$select public.prune_booking_sync_log()$$
);
