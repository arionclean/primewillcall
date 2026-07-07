-- SMS chat support: dedupe key for Twilio backfill, realtime feed,
-- and a DB-aggregated conversation list for the /messages UI.

-- Unique key so syncing from the Twilio Messages API can upsert without
-- duplicating rows already logged by the webhook or by our own sends.
-- Plain unique index: NULL sids (failed sends) do not conflict.
CREATE UNIQUE INDEX IF NOT EXISTS sms_messages_twilio_sid_key
ON public.sms_messages (twilio_sid);

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
-- SECURITY INVOKER (default): callers only see rows their RLS policies allow,
-- so anon/kiosk users get an empty list and merchants get everything.
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
      CASE WHEN direction = 'inbound' THEN from_number ELSE to_number END AS counterpart,
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
