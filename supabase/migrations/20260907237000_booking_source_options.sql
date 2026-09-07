-- Where a desk booking came from: the choices the /schedule form offers.
--
-- A booking typed in by staff used to land with no channel at all (it showed as
-- "Direct" on analytics), while Bubble asked for a supplier chip. The form now
-- requires a source and only accepts one of these rows, so desk bookings sort into
-- the right category (a partner, an OTA phoned in, a website guest at the desk, a
-- plain walk-up). The value is stored as bookings.source_channel as is; the
-- analytics labels table folds spelling variants, these are already the clean names.
-- Owner-edited (no screen yet, SQL). Every active staffer reads it (the form runs
-- as the staffer).

create table if not exists public.booking_source_options (
  channel    text primary key,
  sort_order integer not null default 100,
  is_active  boolean not null default true,
  updated_at timestamptz not null default now()
);

comment on table public.booking_source_options is
  'Sources the /schedule form offers for a desk booking. Stored verbatim as bookings.source_channel. Owner-edited.';

alter table public.booking_source_options enable row level security;

drop policy if exists booking_source_options_select on public.booking_source_options;
create policy booking_source_options_select on public.booking_source_options
  for select to authenticated
  using (exists (select 1 from public.current_staff()));

drop policy if exists booking_source_options_owner_write on public.booking_source_options;
create policy booking_source_options_owner_write on public.booking_source_options
  for all to authenticated
  using      (exists (select 1 from public.current_staff() cs where cs.role = 'owner'))
  with check (exists (select 1 from public.current_staff() cs where cs.role = 'owner'));

insert into public.booking_source_options (channel, sort_order) values
  ('Manual',                                10),
  ('Phone reservation',                     20),
  ('Miami Tour Bus',                        30),
  ('Big Dave',                              40),
  ('Viator',                                50),
  ('GetYourGuide',                          60),
  ('Groupon',                               70),
  ('Civitatis',                             80),
  ('Miami Skyline Cruises - Website',       90),
  ('Miami Bayside Boat Tour - Website',    100),
  ('Miami Sunset Boat - Website',          110),
  ('Key West Sightseeing Tours - Website', 120),
  ('Hop On Hop Off Miami - Website',       130)
on conflict (channel) do update
  set sort_order = excluded.sort_order, is_active = true, updated_at = now();
