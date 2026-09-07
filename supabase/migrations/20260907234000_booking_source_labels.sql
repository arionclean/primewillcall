-- Booking source labels: one editable place for how a raw booking channel is shown.
--
-- `bookings.source_channel` holds whatever the booking system sent. Bokun stamps its own
-- channel names ("Default Channel", "Miami Skyline", "www.miamicelebrityboattours.com -
-- Website"), the Xano mirror renames /gp bookings to "groupon-surcharge", and so on. The
-- same website ended up under four names on /analytics and nobody could tell what
-- "Default Channel" was (the Bayside site's Bokun widget, the one the jet ski sells through).
--
-- The raw value stays on the booking: RLS (unpaid /gp rows), the Redeem chip and the Xano
-- mirror all key on it. This table only decides the name analytics shows. A channel with
-- no row shows as is, an empty channel shows as "Direct". Match is case-insensitive.
-- Every active staffer can read it (the analytics RPC is SECURITY INVOKER and joins it);
-- only the owner edits it.

create table if not exists public.booking_source_labels (
  channel    text primary key,
  label      text not null,
  updated_at timestamptz not null default now()
);

comment on table public.booking_source_labels is
  'Display name per raw bookings.source_channel, for analytics. Owner-edited. Raw values are never rewritten.';

create unique index if not exists booking_source_labels_channel_ci
  on public.booking_source_labels (lower(channel));

alter table public.booking_source_labels enable row level security;

drop policy if exists booking_source_labels_select on public.booking_source_labels;
create policy booking_source_labels_select on public.booking_source_labels
  for select to authenticated
  using (exists (select 1 from public.current_staff()));

drop policy if exists booking_source_labels_owner_write on public.booking_source_labels;
create policy booking_source_labels_owner_write on public.booking_source_labels
  for all to authenticated
  using      (exists (select 1 from public.current_staff() cs where cs.role = 'owner'))
  with check (exists (select 1 from public.current_staff() cs where cs.role = 'owner'));

-- Seed: the labels agreed on 2026-09-07. One format: an OTA is its brand name, a
-- website widget is "<Site> - Website", the kiosk is "Kiosk - <Card|Cash>". Bokun
-- account per website: 4TH = Skyline, BOAT = Bayside / jet ski, MIA = Star Island,
-- SUN = Sunset Boat. kiosk-sale-tap was Tap to Pay on iPhone (Jan 6 to Mar 26, 2026);
-- the kiosk now writes only card and cash. The spelling variants are the free-text
-- channel Bubble staff typed before the field was locked down.
insert into public.booking_source_labels (channel, label) values
  ('groupon',                                    'Groupon'),
  ('groupon-surcharge',                          'Groupon'),
  ('kiosk-sale-card',                            'Kiosk - Card'),
  ('kiosk-sale-tap',                             'Kiosk - Card'),
  ('kiosk-sale-cash',                            'Kiosk - Cash'),
  ('Viator.com',                                 'Viator'),
  ('Viator',                                     'Viator'),
  ('Viator.com<http://viator.com/>',             'Viator'),
  ('civitatis.com',                              'Civitatis'),
  ('Civitatis',                                  'Civitatis'),
  ('civitatis.com<http://civitatis.com/>',       'Civitatis'),
  ('www.tiqets.com/en/',                         'Tiqets'),
  ('www.tiqets.com',                             'Tiqets'),
  ('www.klook.com',                              'Klook'),
  ('headout.com',                                'Headout'),
  ('www.tripshock.com',                          'TripShock'),
  ('Miami Skyline',                              'Miami Skyline Cruises - Website'),
  ('Miami Skyline Cruises',                      'Miami Skyline Cruises - Website'),
  ('Miami Skyline Cruisees',                     'Miami Skyline Cruises - Website'),
  ('Default Channel',                            'Miami Bayside Boat Tour - Website'),
  ('Miami Star Island',                          'Miami Bayside Boat Tour - Website'),
  ('Miami Star Island Cruises',                  'Miami Bayside Boat Tour - Website'),
  ('Miami Boat Tours - Website',                 'Miami Bayside Boat Tour - Website'),
  ('Miami Boat Tours/ Bayside Kiosk - Website',  'Miami Bayside Boat Tour - Website'),
  ('Miami Bayside Boat Tour',                    'Miami Bayside Boat Tour - Website'),
  ('www.miamicelebrityboattours.com - Website',  'Miami Bayside Boat Tour - Website'),
  ('Miami Sunset Boat',                          'Miami Sunset Boat - Website'),
  ('Miami Sunset Boat Cruises',                  'Miami Sunset Boat - Website'),
  ('Miami Sunset Boat Cruises - Website',        'Miami Sunset Boat - Website'),
  ('Key West Sightseeing Tours',                 'Key West Sightseeing Tours - Website'),
  ('Key West Sightseeing',                       'Key West Sightseeing Tours - Website'),
  ('Prime-combo-sale',                           'Prime Combo Sale'),
  ('Prime combo-sale',                           'Prime Combo Sale'),
  ('Prime-combo sale',                           'Prime Combo Sale'),
  ('www.ineedtours.com',                         'I Need Tours'),
  ('miami architecture cruise',                  'Miami Architecture Cruise'),
  ('Miami Architecture cruises',                 'Miami Architecture Cruise'),
  ('architecture cruises',                       'Miami Architecture Cruise')
on conflict (channel) do update
  set label = excluded.label, updated_at = now();

-- The analytics RPC reads the label. Replaces the hard-coded Groupon fold from
-- 20260907233000; otherwise the same body (source x tour x business, aggregated in the
-- database, SECURITY INVOKER so RLS scopes the caller).
create or replace function public.analytics_source_tour(
  p_start timestamptz,
  p_end   timestamptz
)
returns table (
  source      text,
  tour        text,
  color       text,
  business_id uuid,
  business    text,
  pax         bigint,
  bookings    bigint
)
language sql
stable
set search_path to 'public'
as $$
  select
    coalesce(l.label, nullif(btrim(b.source_channel), ''), 'Direct') as source,
    coalesce(t.name, bt.name, 'Unknown')                             as tour,
    t.color                                                           as color,
    biz.id                                                            as business_id,
    biz.name                                                          as business,
    sum(b.pax_adult + b.pax_child + b.pax_infant)::bigint             as pax,
    count(*)::bigint                                                  as bookings
  from bookings b
  join business_tours bt on bt.id = b.business_tour_id
  join businesses biz on biz.id = b.business_id
  left join tours t on t.id = bt.tour_id
  left join booking_source_labels l
         on lower(l.channel) = lower(btrim(b.source_channel))
  where b.starts_at >= p_start
    and b.starts_at <  p_end
    and b.status <> 'cancelled'
  group by 1, 2, 3, 4, 5
$$;
