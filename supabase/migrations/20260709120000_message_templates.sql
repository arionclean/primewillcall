-- Editable message templates for the messaging automations.
-- The owner edits these in /admin/messaging; sendBookingConfirmationSms()
-- renders them with {{placeholders}}. WhatsApp templates are NOT stored here:
-- they live in Twilio's Content API (source of truth for approval status).

CREATE TABLE IF NOT EXISTS public.message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  channel text NOT NULL CHECK (channel IN ('sms', 'whatsapp')),
  label text NOT NULL,
  description text,
  body text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

DROP TRIGGER IF EXISTS set_message_templates_updated_at ON public.message_templates;
CREATE TRIGGER set_message_templates_updated_at
BEFORE UPDATE ON public.message_templates
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.message_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "message_templates_select" ON public.message_templates;
CREATE POLICY "message_templates_select"
ON public.message_templates
FOR SELECT
TO authenticated
USING (EXISTS (SELECT 1 FROM current_staff()));

DROP POLICY IF EXISTS "message_templates_write" ON public.message_templates;
CREATE POLICY "message_templates_write"
ON public.message_templates
FOR ALL
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM current_staff() cs(staff_id, role, business_id)
    WHERE cs.role = 'owner'::staff_role
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM current_staff() cs(staff_id, role, business_id)
    WHERE cs.role = 'owner'::staff_role
  )
);

-- Seed with the exact wording the Xano automation uses today.
INSERT INTO public.message_templates (key, channel, label, description, body)
VALUES
  (
    'sms_booking_intro',
    'sms',
    'First contact intro',
    'Sent once, the very first time we text a phone number, right before the booking confirmation.',
    'Hi {{first_name}}, it''s Jessi from {{product_name}}'
  ),
  (
    'sms_booking_confirmation',
    'sms',
    'Booking confirmation',
    'Sent for every new booking, with the ticket and meeting point link.',
    'Use this link to see your ticket and the meeting point information: {{booking_link}} (Text STOP to unsubscribe).'
  )
ON CONFLICT (key) DO NOTHING;
