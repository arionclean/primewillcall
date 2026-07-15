-- Booking-driven automations + hard SMS-spend guardrails. EVERYTHING OFF BY DEFAULT.
--
-- Safety model (money is the concern):
--  * messaging_settings.automations_enabled defaults FALSE. Nothing fires until
--    an owner deliberately flips it.
--  * The bookings trigger only fires for Supabase-NATIVE bookings (legacy_id IS
--    NULL). The ~90k Xano-synced rows (legacy_id set) are excluded, so turning
--    this on can never blast the historical/OTA feed (Xano still texts those).
--  * Nothing sends inline. The trigger only ENQUEUES into scheduled_messages;
--    the dispatch-scheduled-messages edge function is the single Twilio caller
--    and enforces a global hourly cap (sms_hourly_cap, default 100). Overflow is
--    held (still 'pending'), never dropped, and an alert is logged/sent.

-- ---------------------------------------------------------------------------
-- Settings (single row) + alert log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.messaging_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  automations_enabled boolean NOT NULL DEFAULT false,
  sms_hourly_cap integer NOT NULL DEFAULT 100 CHECK (sms_hourly_cap >= 0),
  booking_link_base text NOT NULL DEFAULT 'https://bked.io/booking',
  alert_phone text,
  alert_last_sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);
INSERT INTO public.messaging_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

DROP TRIGGER IF EXISTS set_messaging_settings_updated_at ON public.messaging_settings;
CREATE TRIGGER set_messaging_settings_updated_at
BEFORE UPDATE ON public.messaging_settings
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.messaging_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "messaging_settings_select" ON public.messaging_settings;
CREATE POLICY "messaging_settings_select" ON public.messaging_settings
FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM current_staff() cs(staff_id, role, business_id)
               WHERE cs.role = 'owner'::staff_role));

CREATE TABLE IF NOT EXISTS public.messaging_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  kind text NOT NULL DEFAULT 'hourly_cap',
  sent_last_hour integer,
  queued_remaining integer,
  notified boolean NOT NULL DEFAULT false,
  detail jsonb
);
ALTER TABLE public.messaging_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "messaging_alerts_select" ON public.messaging_alerts;
CREATE POLICY "messaging_alerts_select" ON public.messaging_alerts
FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM current_staff() cs(staff_id, role, business_id)
               WHERE cs.role = 'owner'::staff_role));

-- ---------------------------------------------------------------------------
-- Trigger: enqueue automations for bookings BORN in Supabase, only when enabled
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.on_native_booking_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  enabled boolean;
  secret text;
BEGIN
  -- Kill switch: off means do absolutely nothing (no external call).
  SELECT automations_enabled INTO enabled FROM public.messaging_settings WHERE id = true;
  IF NOT COALESCE(enabled, false) THEN
    RETURN NEW;
  END IF;

  SELECT decrypted_secret INTO secret
  FROM vault.decrypted_secrets WHERE name = 'dispatch_cron_secret';
  IF secret IS NULL THEN
    RETURN NEW;
  END IF;

  -- Fire-and-forget: hand the booking to the enqueue-only edge function.
  PERFORM net.http_post(
    url := 'https://qbnizuhozzwkiitfkjee.supabase.co/functions/v1/run-booking-automations',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
    body := jsonb_build_object('booking_id', NEW.id)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_native_booking_automations ON public.bookings;
CREATE TRIGGER trg_native_booking_automations
AFTER INSERT ON public.bookings
FOR EACH ROW
WHEN (NEW.legacy_id IS NULL)
EXECUTE FUNCTION public.on_native_booking_created();
