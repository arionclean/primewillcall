-- SMS messaging log and opt-out registry
-- Supabase-native replacement for Xano's message_historial table and the
-- STOP handling embedded in "analyze inbound message_v2".
-- Written by the service role only (API routes); merchants can read.

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
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  direction public.sms_direction NOT NULL,
  from_number text NOT NULL,
  to_number text NOT NULL,
  body text NOT NULL,
  tag text,
  status text,
  twilio_sid text,
  error text,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

CREATE INDEX IF NOT EXISTS sms_messages_to_number_idx ON public.sms_messages (to_number);
CREATE INDEX IF NOT EXISTS sms_messages_from_number_idx ON public.sms_messages (from_number);
CREATE INDEX IF NOT EXISTS sms_messages_created_at_idx ON public.sms_messages (created_at DESC);

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

-- No insert/update/delete policies: only the service role (used by the API
-- routes) can write. Merchants get read access for message history screens.

DROP POLICY IF EXISTS "sms_messages_select_merchant" ON public.sms_messages;
CREATE POLICY "sms_messages_select_merchant"
ON public.sms_messages
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.app_users au
    WHERE au.id = (select auth.uid()) AND au.role = 'merchant'
  )
);

DROP POLICY IF EXISTS "sms_opt_outs_select_merchant" ON public.sms_opt_outs;
CREATE POLICY "sms_opt_outs_select_merchant"
ON public.sms_opt_outs
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.app_users au
    WHERE au.id = (select auth.uid()) AND au.role = 'merchant'
  )
);
