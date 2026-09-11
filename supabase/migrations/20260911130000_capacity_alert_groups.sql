-- One capacity alert can watch SEVERAL products.
--
-- Replaces the one-row-per-tour shape from the previous migration, which was
-- wrong for the case it was ported from: Xano's city tour alert sums two
-- products ("Miami 5 in 1 City Tour" and "Miami City Tour combo") against a
-- single threshold, because they ride the same bus. Counting them separately
-- would never reach the number.
--
-- So the alert is the thing that gets a threshold, recipients and a dedupe, and
-- it holds one or more tours. A tour may belong to at most one alert, otherwise
-- one booking would alert twice.
--
-- The previous tables shipped minutes ago and hold nothing, so they are dropped
-- rather than migrated.

DROP TRIGGER IF EXISTS trg_booking_slot_capacity_insert ON public.bookings;
DROP TRIGGER IF EXISTS trg_booking_slot_capacity_update ON public.bookings;
DROP FUNCTION IF EXISTS public.tour_slot_seats(uuid, timestamptz);
DROP TABLE IF EXISTS public.tour_slot_alert_log;
DROP TABLE IF EXISTS public.tour_slot_alerts;

-- ---------------------------------------------------------------------------
-- The alert
-- ---------------------------------------------------------------------------
CREATE TABLE public.capacity_alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  threshold_pax integer NOT NULL CHECK (threshold_pax > 0),
  phones        text[] NOT NULL DEFAULT '{}',
  emails        text[] NOT NULL DEFAULT '{}',
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at    timestamptz NOT NULL DEFAULT timezone('utc', now())
);

COMMENT ON TABLE public.capacity_alerts IS
  'Tell staff when a departure reaches threshold_pax seats. Seats are summed across every product the alert holds.';

CREATE TRIGGER set_capacity_alerts_updated_at
BEFORE UPDATE ON public.capacity_alerts
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.capacity_alert_tours (
  alert_id uuid NOT NULL REFERENCES public.capacity_alerts(id) ON DELETE CASCADE,
  tour_id  uuid NOT NULL REFERENCES public.tours(id) ON DELETE CASCADE,
  PRIMARY KEY (alert_id, tour_id)
);

-- One alert per product: two alerts on the same tour would text twice.
CREATE UNIQUE INDEX capacity_alert_tours_one_alert_per_tour
  ON public.capacity_alert_tours (tour_id);

-- ---------------------------------------------------------------------------
-- One row per departure already alerted on (the dedupe)
-- ---------------------------------------------------------------------------
CREATE TABLE public.capacity_alert_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id      uuid NOT NULL REFERENCES public.capacity_alerts(id) ON DELETE CASCADE,
  starts_at     timestamptz NOT NULL,
  seats         integer NOT NULL,
  threshold_pax integer NOT NULL,
  sms_sent      integer NOT NULL DEFAULT 0,
  emails_sent   integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT timezone('utc', now()),
  UNIQUE (alert_id, starts_at)
);

COMMENT ON TABLE public.capacity_alert_log IS
  'One row per departure already alerted on. The unique key is the dedupe: it is claimed before sending, so a retry cannot text twice. Seeding a row silences that departure.';

-- ---------------------------------------------------------------------------
-- RLS: owner only, on all three
-- ---------------------------------------------------------------------------
ALTER TABLE public.capacity_alerts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capacity_alert_tours  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capacity_alert_log    ENABLE ROW LEVEL SECURITY;

CREATE POLICY capacity_alerts_owner_all ON public.capacity_alerts
  FOR ALL TO authenticated
  USING      (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'));

CREATE POLICY capacity_alert_tours_owner_all ON public.capacity_alert_tours
  FOR ALL TO authenticated
  USING      (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'));

CREATE POLICY capacity_alert_log_owner_select ON public.capacity_alert_log
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'));

-- ---------------------------------------------------------------------------
-- Seats booked on one departure, summed in the database
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER on purpose: the answer spans every business selling the
-- products (they share the vehicle), which a manager's own RLS scope would cut
-- short. Nothing in the app calls it, so execute goes to the service role only.
CREATE OR REPLACE FUNCTION public.capacity_alert_seats(p_alert_id uuid, p_starts_at timestamptz)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(SUM(b.pax_adult + b.pax_child), 0)::integer
    FROM public.bookings b
    JOIN public.business_tours bt ON bt.id = b.business_tour_id
    JOIN public.capacity_alert_tours cat ON cat.tour_id = bt.tour_id
   WHERE cat.alert_id = p_alert_id
     AND b.starts_at = p_starts_at
     AND b.status <> 'cancelled'
     AND b.awaiting_payment = false;
$$;

REVOKE ALL ON FUNCTION public.capacity_alert_seats(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capacity_alert_seats(uuid, timestamptz) TO service_role;

-- ---------------------------------------------------------------------------
-- Triggers: hand a booking that could have filled a departure to the function
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.on_booking_capacity_alert()
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

CREATE TRIGGER trg_booking_capacity_alert_insert
AFTER INSERT ON public.bookings
FOR EACH ROW
WHEN (
  NEW.starts_at > now()
  AND NEW.status <> 'cancelled'
  AND NEW.awaiting_payment = false
)
EXECUTE FUNCTION public.on_booking_capacity_alert();

-- An edit only matters when it can ADD seats to a departure: a checkout that
-- finally paid, more guests, an un-cancel, or a move to another time. Every
-- other update (check-in, a note, a balance) is left alone, so a busy day does
-- not fire hundreds of pointless calls.
CREATE TRIGGER trg_booking_capacity_alert_update
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
EXECUTE FUNCTION public.on_booking_capacity_alert();

DROP FUNCTION IF EXISTS public.on_booking_slot_capacity();
