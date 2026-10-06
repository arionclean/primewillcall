-- Per-kiosk switches for the faster card sale. kiosk-config hands them to the
-- tablet at boot and on every return to the foreground; the server reads them
-- again on each call. Both default to today's behaviour, so a kiosk nobody has
-- switched, and an app build that predates the switch, run exactly what runs now.
--
-- edge_region: where the tablet's two payment calls execute. NULL = wherever the
-- platform routes them (today us-east-1, a continent away from the database in
-- us-west-2, and a sale makes about thirty database round trips). 'us-west-2' =
-- next to the database. The CHECK keeps a typo from ever reaching a tablet.
--
-- sale_settle: 'inline' = the guest keeps waiting while the paid sale is copied
-- into Xano (today). 'deferred' = the guest is told paid first and the copy runs
-- right after the reply, with kiosk-sale-sweep as the retry. It takes effect only
-- when the tablet also sends fast_settle on the call, so an old build on a
-- switched kiosk changes nothing.
alter table public.kiosks
  add column if not exists edge_region text,
  add column if not exists sale_settle text not null default 'inline';

alter table public.kiosks drop constraint if exists kiosks_edge_region_check;
alter table public.kiosks
  add constraint kiosks_edge_region_check
  check (edge_region is null or edge_region in ('us-west-2'));

alter table public.kiosks drop constraint if exists kiosks_sale_settle_check;
alter table public.kiosks
  add constraint kiosks_sale_settle_check
  check (sale_settle in ('inline', 'deferred'));

comment on column public.kiosks.edge_region is
  'Region the tablet pins kiosk-sale-start and kiosk-sale-complete to. NULL = platform default.';
comment on column public.kiosks.sale_settle is
  'inline: guest waits for the Xano copy. deferred: reply first, copy after (needs the tablet to send fast_settle).';
