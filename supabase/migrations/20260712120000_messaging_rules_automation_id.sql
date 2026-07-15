-- Give each automation an explicit identity. Until now an "automation" was
-- derived from (trigger_event, business_tour_id), so two automations for the
-- same trigger and product merged into one. `automation_id` makes them
-- independent: an automation is the set of messaging_rules sharing this id.
-- New rows default to a fresh id (a brand-new automation); adding an action to
-- an existing automation copies that automation's id.

ALTER TABLE public.messaging_rules
  ADD COLUMN IF NOT EXISTS automation_id uuid NOT NULL DEFAULT gen_random_uuid();

-- Backfill: rules that shared a trigger + product were one automation, keep them so.
WITH groups AS (
  SELECT trigger_event, business_tour_id, gen_random_uuid() AS aid
  FROM public.messaging_rules
  GROUP BY trigger_event, business_tour_id
)
UPDATE public.messaging_rules m
SET automation_id = g.aid
FROM groups g
WHERE m.trigger_event = g.trigger_event
  AND m.business_tour_id IS NOT DISTINCT FROM g.business_tour_id;

CREATE INDEX IF NOT EXISTS messaging_rules_automation_id_idx
  ON public.messaging_rules (automation_id);
