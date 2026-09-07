-- Due amount on a booking.
--
-- The desk used to write what a guest still owes into the guest's name ("Alfred B
-- Owes $36"). It has its own column now, so the bookings list can show an "Owes $36"
-- tag, the edit form can clear it, and the kiosk can later collect it against this
-- booking instead of creating a second sale (the Big Dave double count). Amount in
-- cents, 0 = nothing owed. The price (total_cents) is unchanged by it.
--
-- create_booking() takes it as p_due_cents. Adding a defaulted parameter changes the
-- signature, so the old overload is dropped first (create or replace would leave two
-- functions and every caller ambiguous). Callers that do not send it (gp-book) get 0.

alter table public.bookings
  add column if not exists due_cents integer not null default 0
  constraint bookings_due_cents_nonnegative check (due_cents >= 0);

comment on column public.bookings.due_cents is
  'What the guest still owes at the desk, in cents. 0 = paid. Separate from total_cents (the price).';

drop function if exists public.create_booking(
  uuid, date, time without time zone, text, text, jsonb, integer, text, text, text, text,
  booking_status, text, text, integer, uuid, boolean, boolean, text[], text[]
);

create function public.create_booking(
  p_business_tour_id      uuid,
  p_date                  date,
  p_slot_start            time without time zone,
  p_customer_name         text,
  p_pricing               text default 'tiers',
  p_pax                   jsonb default '{}'::jsonb,
  p_passengers            integer default 0,
  p_customer_email        text default null,
  p_customer_phone        text default null,
  p_customer_legacy_source text default null,
  p_notes                 text default null,
  p_status                booking_status default 'confirmed',
  p_source_channel        text default null,
  p_legacy_reference      text default null,
  p_total_override_cents  integer default null,
  p_created_by_staff_id   uuid default null,
  p_respect_closures      boolean default false,
  p_active_slots_only     boolean default false,
  p_groupon_voucher_urls  text[] default '{}'::text[],
  p_groupon_voucher_codes text[] default '{}'::text[],
  p_due_cents             integer default 0
)
returns table (
  booking_id   uuid,
  public_token text,
  total_cents  integer,
  starts_at    timestamptz,
  ends_at      timestamptz
)
language plpgsql
set search_path to 'public'
as $$
declare
  v_business_id uuid;
  v_tour_id uuid;
  v_bt_name text;
  v_fee_cents integer;
  v_duration integer;
  v_starts timestamptz;
  v_ends timestamptz;
  v_total integer := 0;
  v_qty integer := 0;
  v_adult integer := 0;
  v_child integer := 0;
  v_infant integer := 0;
  v_breakdown jsonb := '[]'::jsonb;
  v_customer_id uuid;
  v_booking record;
begin
  select bt.business_id, bt.tour_id, bt.name, bt.groupon_fee_cents
    into v_business_id, v_tour_id, v_bt_name, v_fee_cents
  from business_tours bt
  join tours t on t.id = bt.tour_id
  where bt.id = p_business_tour_id
    and bt.is_active
    and t.is_active;

  if v_business_id is null then
    raise exception 'tour_not_available';
  end if;

  select ts.duration_minutes into v_duration
  from tour_timeslots ts
  where ts.tour_id = v_tour_id
    and ts.start_time = p_slot_start
    and (not p_active_slots_only or ts.is_active)
  limit 1;

  if v_duration is null then
    raise exception 'bad_slot';
  end if;

  if p_respect_closures and exists (
    select 1 from tour_slot_closures c
    where c.tour_id = v_tour_id and c.closed_on = p_date and c.start_time = p_slot_start
  ) then
    raise exception 'slot_closed';
  end if;

  v_starts := (p_date + p_slot_start) at time zone 'America/New_York';
  v_ends := v_starts + make_interval(mins => v_duration);

  if p_pricing = 'groupon' then
    if v_fee_cents is null then
      raise exception 'groupon_not_available';
    end if;
    v_qty := greatest(1, coalesce(p_passengers, 0));
    v_total := v_fee_cents * v_qty;
    v_adult := v_qty;
    v_breakdown := jsonb_build_array(jsonb_build_object(
      'label', 'Groupon convenience fee',
      'qty', v_qty,
      'unit_price_cents', v_fee_cents,
      'line_total_cents', v_total
    ));

  elsif p_pricing = 'tiers' then
    if not exists (select 1 from tour_pax_tiers where business_tour_id = p_business_tour_id) then
      raise exception 'no_prices';
    end if;

    select
      coalesce(jsonb_agg(jsonb_build_object(
        'tier_id', line.id,
        'label', line.label,
        'qty', line.qty,
        'unit_price_cents', line.price_cents,
        'line_total_cents', line.qty * line.price_cents
      ) order by line.sort_order), '[]'::jsonb),
      coalesce(sum(line.qty * line.price_cents), 0),
      coalesce(sum(line.qty), 0),
      coalesce(sum(line.qty) filter (where lower(line.label) = 'adult'), 0),
      coalesce(sum(line.qty) filter (where lower(line.label) = 'child'), 0),
      coalesce(sum(line.qty) filter (where lower(line.label) = 'infant'), 0)
      into v_breakdown, v_total, v_qty, v_adult, v_child, v_infant
    from (
      select t.id, t.label, t.price_cents, t.sort_order,
             floor((p_pax ->> t.id::text)::numeric)::integer as qty
      from tour_pax_tiers t
      where t.business_tour_id = p_business_tour_id
        and (p_pax ->> t.id::text) is not null
    ) line
    where line.qty > 0;

    if v_qty = 0 then
      raise exception 'no_guests';
    end if;

  else
    raise exception 'bad_pricing_mode';
  end if;

  if p_total_override_cents is not null then
    v_total := p_total_override_cents;
  end if;

  insert into customers (business_id, full_name, email, phone, legacy_source)
  values (v_business_id, p_customer_name, p_customer_email, p_customer_phone, p_customer_legacy_source)
  returning id into v_customer_id;

  insert into bookings (
    business_id, business_tour_id, customer_id, starts_at, ends_at, status,
    total_cents, currency, notes, created_by_staff_id,
    pax_adult, pax_child, pax_infant, tour_pax_breakdown,
    source_channel, legacy_reference, groupon_voucher_urls, groupon_voucher_codes,
    due_cents
  )
  values (
    v_business_id, p_business_tour_id, v_customer_id, v_starts, v_ends, p_status,
    v_total, 'usd', p_notes, p_created_by_staff_id,
    v_adult, v_child, v_infant, v_breakdown,
    p_source_channel, p_legacy_reference, coalesce(p_groupon_voucher_urls, '{}'::text[]),
    coalesce(p_groupon_voucher_codes, '{}'::text[]),
    greatest(0, coalesce(p_due_cents, 0))
  )
  returning bookings.id, bookings.public_token into v_booking;

  return query select v_booking.id, v_booking.public_token, v_total, v_starts, v_ends;
end;
$$;

comment on function public.create_booking is
  'Creates a customer + booking in one transaction, with slot duration and pricing read from the database. SECURITY INVOKER, so RLS governs the caller. Used by the staff /schedule form and the public gp-book edge function. p_due_cents = what the guest still owes at the desk.';

revoke all on function public.create_booking from public;
grant execute on function public.create_booking to authenticated, service_role;
