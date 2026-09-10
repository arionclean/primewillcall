-- The Xano identity behind each tablet login.
--
-- When a tablet signs in through Xano, Xano's answer carries two ids the tablet
-- keeps for the rest of the session: `unique_id`, Xano's id for that kiosk, which
-- it stamps on every sale and booking it posts to Xano, and `company`, Xano's id
-- for the business, which it puts on every booking. kiosk-login now signs the
-- tablet in here instead, and while a tablet still writes to Xano those two ids
-- have to keep coming from somewhere. This is where.
--
-- Taken from Xano's own `user` table (workspace 6, table 57) on 2026-09-10 and
-- checked against scripts/xano_kiosk_map.json, which proved the same four kiosk
-- ids against overlapping sales. bayride was not in that map; its id is the one
-- on its Xano account. kiosk4 carries Miami Skyline's company id in Xano even
-- though its business here is Miami Jet Ski Tours, which is why the company id
-- is stored per kiosk rather than read off the business.
--
-- Nullable on purpose: a kiosk with no Xano account (one born after Xano is
-- gone) signs in fine and simply sends no Xano id.

alter table public.kiosks
  add column if not exists xano_kiosk_id text,
  add column if not exists xano_company_id text;

comment on column public.kiosks.xano_kiosk_id is
  'Xano''s id for this kiosk (the old login''s unique_id). Sent on every Xano write while a tablet still writes there.';
comment on column public.kiosks.xano_company_id is
  'Xano''s id for the business this kiosk books under (the old login''s company). Not always the business''s own legacy id.';

update public.kiosks k
set xano_kiosk_id   = v.kiosk_id,
    xano_company_id = v.company_id
from (values
  ('kiosk1',  '1760408777575x901503164165246200', '1712896100693x988159247184035800'),
  ('kiosk2',  '1767110154468x572695862995220600', '1712894857551x926333421634977800'),
  ('kiosk3',  '1711112568137x325014630279620800', '1712894857551x926333421634977800'),
  ('kiosk4',  '1711112568137x325014630279620900', '1712894857551x926333421634977800'),
  ('bayride', '1711112568137x325014630279620400', null)
) as v(slug, kiosk_id, company_id)
where k.slug = v.slug;
