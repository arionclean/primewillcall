-- create_booking(): one place where a booking comes into existence.
--
-- Before this, booking creation lived twice in TypeScript: the staff form
-- (src/app/(app)/schedule/actions.ts) and the public Groupon page (the gp-book edge
-- function). Both re-derived the same things by hand, and each had the same two holes:
--
--   1. **Two statements, no transaction.** They inserted the customer, then the booking.
--      A failure on the second left an orphan customer row behind. A function body is a
--      single transaction, so that cannot happen here.
--   2. **The client supplied the duration.** /schedule posted `slot_duration` from the
--      form and trusted it. Here the duration is read from `tour_timeslots`, so `ends_at`
--      is always the tour's real duration.
--
-- Pricing is likewise never taken from the caller. In `tiers` mode the unit prices come
-- from `tour_pax_tiers`; in `groupon` mode from `business_tours.groupon_fee_cents`. The
-- only price a caller may impose is `p_total_override_cents`, which is the deliberate
-- desk-side adjustment (discount, cash deal) and leaves the breakdown at list prices.
--
-- SECURITY INVOKER on purpose: it runs as whoever called it, so RLS still decides. The
-- staff form runs as the signed-in user and is governed by the bookings/customers
-- policies; the public gp-book function runs as the service role and bypasses them, the
-- same split as before. A policy violation surfaces as SQLSTATE 42501, which the callers
-- already translate into "You don't have permission".
--
-- Timezone: business time is America/New_York. `(date + time) AT TIME ZONE` resolves the
-- real UTC offset for that date, DST included, replacing a hand-rolled offset parse that
-- was copied into three TypeScript files.
--
-- Errors are raised with a short stable token as the message, so callers can map them to
-- their own wording: tour_not_available, bad_slot, slot_closed, no_prices, no_guests,
-- groupon_not_available.

create or replace function public.create_booking(
  p_business_tour_id uuid,
  p_date date,
  p_slot_start time,
  p_customer_name text,
  p_pricing text default 'tiers',
  p_pax jsonb default '{}'::jsonb,
  p_passengers integer default 0,
  p_customer_email text default null,
  p_customer_phone text default null,
  p_customer_legacy_source text default null,
  p_notes text default null,
  p_status public.booking_status default 'confirmed',
  p_source_channel text default null,
  p_legacy_reference text default null,
  p_total_override_cents integer default null,
  p_created_by_staff_id uuid default null,
  -- Staff may book a closed or inactive departure on purpose (a phone booking for a
  -- slot taken off the public board). The public page may not.
  p_respect_closures boolean default false,
  p_active_slots_only boolean default false
)
returns table (
  booking_id uuid,
  public_token text,
  total_cents integer,
  starts_at timestamptz,
  ends_at timestamptz
)
language plpgsql
security invoker
set search_path = public
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
  -- 1. Product. Both the business's copy and the master tour must be active.
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

  -- 2. The slot must belong to this tour. Its duration is authoritative.
  select ts.duration_minutes into v_duration
  from tour_timeslots ts
  where ts.tour_id = v_tour_id
    and ts.start_time = p_slot_start
    and (not p_active_slots_only or ts.is_active)
  limit 1;

  if v_duration is null then
    raise exception 'bad_slot';
  end if;

  -- 3. Closed for that date on the availability board.
  if p_respect_closures and exists (
    select 1 from tour_slot_closures c
    where c.tour_id = v_tour_id and c.closed_on = p_date and c.start_time = p_slot_start
  ) then
    raise exception 'slot_closed';
  end if;

  -- 4. Wall-clock New York -> UTC, DST-correct.
  v_starts := (p_date + p_slot_start) at time zone 'America/New_York';
  v_ends := v_starts + make_interval(mins => v_duration);

  -- 5. Pricing, always from the database.
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

    -- One pass over the tiers in display order, keeping only the ones the caller
    -- asked for. Quantities come from the caller; unit prices never do.
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

  -- A manual total is a deliberate adjustment: the breakdown keeps list prices and
  -- only the charged total moves.
  if p_total_override_cents is not null then
    v_total := p_total_override_cents;
  end if;

  -- 6. Customer and booking, one transaction. If the booking insert fails (RLS, a
  --    constraint, anything) the customer insert goes with it.
  insert into customers (business_id, full_name, email, phone, legacy_source)
  values (v_business_id, p_customer_name, p_customer_email, p_customer_phone, p_customer_legacy_source)
  returning id into v_customer_id;

  insert into bookings (
    business_id, business_tour_id, customer_id, starts_at, ends_at, status,
    total_cents, currency, notes, created_by_staff_id,
    pax_adult, pax_child, pax_infant, tour_pax_breakdown,
    source_channel, legacy_reference
  )
  values (
    v_business_id, p_business_tour_id, v_customer_id, v_starts, v_ends, p_status,
    v_total, 'usd', p_notes, p_created_by_staff_id,
    v_adult, v_child, v_infant, v_breakdown,
    p_source_channel, p_legacy_reference
  )
  returning bookings.id, bookings.public_token into v_booking;

  return query select v_booking.id, v_booking.public_token, v_total, v_starts, v_ends;
end;
$$;

comment on function public.create_booking is
  'Creates a customer + booking in one transaction, with slot duration and pricing read from the database. SECURITY INVOKER, so RLS governs the caller. Used by the staff /schedule form and the public gp-book edge function.';

revoke all on function public.create_booking from public;
grant execute on function public.create_booking to authenticated, service_role;
