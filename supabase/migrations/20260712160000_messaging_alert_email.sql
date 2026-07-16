-- Email channel for the cap alert (via Resend). SMS can't reach an inbox like
-- hello@primewillcall.com, so the dispatcher can now email the alert instead of
-- (or as well as) texting alert_phone.
--
--  * alert_email       - who the cap alert emails (a real mailbox, e.g. Titan).
--  * alert_email_from  - the From address, which MUST be on a Resend-verified
--                        domain (here the alert.primewillcall.com subdomain).
-- The RESEND_API_KEY is a dispatch-scheduled-messages function secret, not a DB
-- value. Email only sends when both alert_email and RESEND_API_KEY are set.

ALTER TABLE public.messaging_settings
  ADD COLUMN IF NOT EXISTS alert_email text,
  ADD COLUMN IF NOT EXISTS alert_email_from text NOT NULL
    DEFAULT 'PrimeWillCall Alerts <alerts@alert.primewillcall.com>';
