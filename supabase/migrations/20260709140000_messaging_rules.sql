-- Messaging rules: "when a new booking comes in for <product>, send <sms|whatsapp>".
-- Replaces the fixed message_templates pair with an owner-editable rule list.
-- WhatsApp rules reference an approved Twilio Content template by sid.

CREATE TABLE IF NOT EXISTS public.messaging_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  trigger_event text NOT NULL DEFAULT 'new_booking' CHECK (trigger_event IN ('new_booking')),
  business_tour_id uuid REFERENCES public.business_tours(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('sms', 'whatsapp')),
  body text,
  whatsapp_content_sid text,
  whatsapp_variables jsonb,
  only_first_contact boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CHECK (channel <> 'sms' OR body IS NOT NULL),
  CHECK (channel <> 'whatsapp' OR whatsapp_content_sid IS NOT NULL)
);

DROP TRIGGER IF EXISTS set_messaging_rules_updated_at ON public.messaging_rules;
CREATE TRIGGER set_messaging_rules_updated_at
BEFORE UPDATE ON public.messaging_rules
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.messaging_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "messaging_rules_select" ON public.messaging_rules;
CREATE POLICY "messaging_rules_select"
ON public.messaging_rules
FOR SELECT
TO authenticated
USING (EXISTS (SELECT 1 FROM current_staff()));

DROP POLICY IF EXISTS "messaging_rules_write" ON public.messaging_rules;
CREATE POLICY "messaging_rules_write"
ON public.messaging_rules
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

-- Carry the current automation texts over from message_templates (preserving
-- any edits), then retire that table.
INSERT INTO public.messaging_rules (name, trigger_event, channel, body, only_first_contact, is_active)
SELECT 'First contact intro', 'new_booking', 'sms', body, true, is_active
FROM public.message_templates
WHERE key = 'sms_booking_intro'
  AND NOT EXISTS (SELECT 1 FROM public.messaging_rules);

INSERT INTO public.messaging_rules (name, trigger_event, channel, body, only_first_contact, is_active)
SELECT 'Booking confirmation', 'new_booking', 'sms', body, false, is_active
FROM public.message_templates
WHERE key = 'sms_booking_confirmation'
  AND NOT EXISTS (
    SELECT 1 FROM public.messaging_rules WHERE name = 'Booking confirmation'
  );

DROP TABLE IF EXISTS public.message_templates;
