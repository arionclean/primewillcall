-- Capacity alerts: tell staff when a departure is close to full.
--
-- Port of Xano's "city tour full notification" / "everglades tour full
-- notification" bookings triggers. Xano hardcoded two product ids, a threshold
-- of 25, one phone and one email, and faked its dedupe by writing rows into an
-- unrelated `messages` table. Here:
--   * the threshold is a fixed number of seats per master tour, owner-edited on
--     /admin/messaging, so any product can have one and none has to;
--   * recipients are per tour (a Key West departure alerts Key West);
--   * the dedupe is a real table with a unique (tour, departure) key, claimed
--     BEFORE anything sends, so a crash mid-send loses an alert rather than
--     double-texting;
--   * seats are counted in the database (adults + children; an infant rides on
--     a lap and takes no seat, the same rule as the check-in manifest).
--
-- OFF BY DEFAULT. messaging_settings.slot_alerts_enabled starts false, and the
-- trigger reads it first, so while it is off nothing leaves the database.
--
-- Every booking counts, Xano-synced ones included: an OTA seat fills the same
-- boat. Historical rows are harmless because the trigger only fires for a
-- departure still in the future, so a bulk import can never alert.

-- ---------------------------------------------------------------------------
-- Kill switch
-- ---------------------------------------------------------------------------
ALTER TABLE public.messaging_settings
  ADD COLUMN IF NOT EXISTS slot_alerts_enabled boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Per-tour configuration
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tour_slot_alerts (
  tour_id       uuid PRIMARY KEY REFERENCES public.tours(id) ON DELETE CASCADE,
  threshold_pax integer NOT NULL CHECK (threshold_pax > 0),
  phones        text[]  NOT NULL DEFAULT '{}',
  emails        text[]  NOT NULL DEFAULT '{}',
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at    timestamptz NOT NULL DEFAULT timezone('utc', now())
);

COMMENT ON TABLE public.tour_slot_alerts IS
  'Per master tour: alert staff once a departure reaches threshold_pax seats. No row means no alert for that tour.';

DROP TRIGGER IF EXISTS set_tour_slot_alerts_updated_at ON public.tour_slot_alerts;
CREATE TRIGGER set_tour_slot_alerts_updated_at
BEFORE UPDATE ON public.tour_slot_alerts
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.tour_slot_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tour_slot_alerts_owner_all ON public.tour_slot_alerts;
CREATE POLICY tour_slot_alerts_owner_all ON public.tour_slot_alerts
  FOR ALL TO authenticated
  USING      (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'));

-- ---------------------------------------------------------------------------
-- One row per departure we have already alerted on (the dedupe)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tour_slot_alert_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tour_id       uuid NOT NULL REFERENCES public.tours(id) ON DELETE CASCADE,
  starts_at     timestamptz NOT NULL,
  seats         integer NOT NULL,
  threshold_pax integer NOT NULL,
  sms_sent      integer NOT NULL DEFAULT 0,
  emails_sent   integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (tour_id, starts_at)
);

COMMENT ON TABLE public.tour_slot_alert_log IS
  'One row per departure already alerted on. The unique key is the dedupe: it is claimed before sending, so a retry cannot text twice.';

ALTER TABLE public.tour_slot_alert_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tour_slot_alert_log_owner_select ON public.tour_slot_alert_log;
CREATE POLICY tour_slot_alert_log_owner_select ON public.tour_slot_alert_log
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'));

-- ---------------------------------------------------------------------------
-- Seats booked on one departure of a master tour, summed in the database
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER on purpose: the answer has to span every business selling
-- the tour (they share the boat), which a manager's own RLS scope would cut
-- short. Nothing in the app calls it, so execute is granted to the service role
-- alone.
CREATE OR REPLACE FUNCTION public.tour_slot_seats(p_tour_id uuid, p_starts_at timestamptz)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(SUM(b.pax_adult + b.pax_child), 0)::integer
    FROM public.bookings b
    JOIN public.business_tours bt ON bt.id = b.business_tour_id
   WHERE bt.tour_id = p_tour_id
     AND b.starts_at = p_starts_at
     AND b.status <> 'cancelled'
     AND b.awaiting_payment = false;
$$;

REVOKE ALL ON FUNCTION public.tour_slot_seats(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tour_slot_seats(uuid, timestamptz) TO service_role;

-- ---------------------------------------------------------------------------
-- Trigger: hand a booking that could have filled a slot to the edge function
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.on_booking_slot_capacity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  enabled boolean;
  secret  text;
BEGIN
  SELECT slot_alerts_enabled INTO enabled FROM public.messaging_settings WHERE id = true;
  IF NOT COALESCE(enabled, false) THEN
    RETURN NEW;
  END IF;

  SELECT decrypted_secret INTO secret
  FROM vault.decrypted_secrets WHERE name = 'dispatch_cron_secret';
  IF secret IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := 'https://qbnizuhozzwkiitfkjee.supabase.co/functions/v1/slot-capacity-alert',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
    body := jsonb_build_object('booking_id', NEW.id)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_booking_slot_capacity_insert ON public.bookings;
CREATE TRIGGER trg_booking_slot_capacity_insert
AFTER INSERT ON public.bookings
FOR EACH ROW
WHEN (
  NEW.starts_at > now()
  AND NEW.status <> 'cancelled'
  AND NEW.awaiting_payment = false
)
EXECUTE FUNCTION public.on_booking_slot_capacity();

-- An edit only matters when it can ADD seats to a departure: a checkout that
-- finally paid, more guests, an un-cancel, or a move to another time. Every
-- other update (check-in, a note, a balance) is left alone, so a busy day does
-- not fire hundreds of pointless calls.
DROP TRIGGER IF EXISTS trg_booking_slot_capacity_update ON public.bookings;
CREATE TRIGGER trg_booking_slot_capacity_update
AFTER UPDATE ON public.bookings
FOR EACH ROW
WHEN (
  NEW.starts_at > now()
  AND NEW.status <> 'cancelled'
  AND NEW.awaiting_payment = false
  AND (
       (OLD.awaiting_payment AND NOT NEW.awaiting_payment)
    OR (OLD.status = 'cancelled')
    OR (OLD.starts_at IS DISTINCT FROM NEW.starts_at)
    OR (OLD.business_tour_id IS DISTINCT FROM NEW.business_tour_id)
    OR (OLD.pax_adult + OLD.pax_child < NEW.pax_adult + NEW.pax_child)
  )
)
EXECUTE FUNCTION public.on_booking_slot_capacity();
