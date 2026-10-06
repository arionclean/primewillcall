-- Backfill kiosk_closings from the kiosk_events log.
--
-- Every close since the tablet started posting them (2026-09-09) lives as a
-- `closing_report` event. Those rows carry the totals, the commission from build
-- 21 on, and who closed, but not the card/cash split of the sale COUNTS and not
-- the product breakdown, so those stay at their defaults for backfilled nights.
-- That is a gap in the history, not in the table: closes recorded from here on
-- carry everything.
--
-- `emailed` is taken from the tablet's own `closing_sent` event within ten
-- minutes of the report, which is how it reports whether Resend accepted it.
--
-- One row per kiosk per night: where a night was closed (or reprinted) more than
-- once, the LAST report wins, matching the rule the live upsert uses.
INSERT INTO public.kiosk_closings (
  kiosk_id, kiosk_slug, business_id, business_date, date_label,
  sales_count, total_cents, card_cents, cash_cents, commission_cents,
  closed_by_name, employee_id, app_build, device_id, emailed, closed_at
)
SELECT DISTINCT ON (e.kiosk_id, to_date(split_part(e.payload->>'date', ', ', 2), 'Mon DD YYYY'))
  e.kiosk_id,
  e.kiosk_slug,
  e.business_id,
  to_date(split_part(e.payload->>'date', ', ', 2), 'Mon DD YYYY'),
  e.payload->>'date',
  COALESCE((e.payload->>'sales')::int, 0),
  COALESCE((e.payload->>'total_cents')::int, 0),
  COALESCE((e.payload->>'card_cents')::int, 0),
  COALESCE((e.payload->>'cash_cents')::int, 0),
  (e.payload->>'commission_cents')::int,
  e.employee_name,
  e.employee_id,
  e.app_build,
  e.device_id,
  COALESCE(
    (SELECT (s.payload->>'emailed')::boolean
       FROM public.kiosk_events s
      WHERE s.event = 'closing_sent'
        AND s.kiosk_id = e.kiosk_id
        AND s.at BETWEEN e.at AND e.at + interval '10 minutes'
      ORDER BY s.at
      LIMIT 1),
    false),
  e.at
FROM public.kiosk_events e
WHERE e.event = 'closing_report'
  AND e.kiosk_id IS NOT NULL
  AND e.payload->>'date' IS NOT NULL
  AND split_part(e.payload->>'date', ', ', 2) <> ''
ORDER BY
  e.kiosk_id,
  to_date(split_part(e.payload->>'date', ', ', 2), 'Mon DD YYYY'),
  e.at DESC
ON CONFLICT (kiosk_id, business_date) DO NOTHING;
