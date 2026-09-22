-- Team -> Sales: the money each person who types a PIN took on the tablets.
--
-- One row per person for a range, summed in the database (the 1000-row read cap
-- would truncate a month summed in the browser). The money is the Payments
-- ledger's, so the two screens always agree:
--
--   * Card: every charge Stripe recorded at a tablet (stripe_transactions whose
--     source is a kiosk slug), less its refunds.
--   * Cash: kiosk cash sales (cash_sales where type = 'cash'; its 'card' rows
--     mirror the Stripe charges and would count them twice), less refunds, voided
--     ones left out.
--
-- Who gets the credit comes from the sale itself, never from the booking: the
-- tablet overwrites bookings.kiosk_employee_id with whoever checks the guest in
-- (kiosk-booking-update), so the booking says who touched it last, not who sold
-- it. A cash sale carries its own employee_id. A card charge carries the sale's
-- KS code as booking_ref, and kiosk_sales.ref is unique, so a charge meets at
-- most one sale and is never counted twice.
--
-- Sales nobody can be credited with (no PIN typed, a tablet that does not ask
-- for one, or a person since removed) come back as one row with a null
-- employee_id, so the rows always add up to the tablets' total.
--
-- Owner only, like the Hours tab next to it. The ledger underneath is readable by
-- a manager (it is their Payments page), so no policy stops them; the owner check
-- is inside the function instead, and anyone else gets no rows. SECURITY INVOKER
-- (the default) all the same, so RLS still applies to what the owner reads.

create or replace function public.team_sales(
  p_start    timestamptz,
  p_end      timestamptz,
  p_business uuid default null
)
returns table (
  employee_id   uuid,
  employee_name text,
  sales         bigint,
  cash_cents    bigint,
  card_cents    bigint
)
language sql
stable
set search_path = public
as $$
  with sale as (
    select
      ks.employee_id,
      'card'::text                           as tender,
      t.amount::bigint                       as amount,
      coalesce(t.amount_refunded, 0)::bigint as refunded
    from public.stripe_transactions t
    left join public.kiosk_sales ks on ks.ref = t.booking_ref
    where t.object_type = 'charge'
      and t.stripe_created >= p_start
      and t.stripe_created <  p_end
      and (p_business is null or t.business_id = p_business)
      and t.source in (select k.slug from public.kiosks k)

    union all

    select
      c.employee_id,
      'cash'::text,
      c.amount_cents::bigint,
      coalesce(c.amount_refunded_cents, 0)::bigint
    from public.cash_sales c
    where c.type = 'cash'
      and c.voided_at is null
      and c.created_at >= p_start
      and c.created_at <  p_end
      and (p_business is null or c.business_id = p_business)
  )
  select
    s.employee_id,
    e.name,
    -- A sale refunded in full no longer counts as one.
    count(*) filter (where s.amount > s.refunded)::bigint,
    coalesce(sum(s.amount - s.refunded) filter (where s.tender = 'cash'), 0)::bigint,
    coalesce(sum(s.amount - s.refunded) filter (where s.tender = 'card'), 0)::bigint
  from sale s
  left join public.kiosk_employees e on e.id = s.employee_id
  where exists (select 1 from public.current_staff() cs where cs.role = 'owner')
  group by s.employee_id, e.name
  order by sum(s.amount - s.refunded) desc, e.name;
$$;

comment on function public.team_sales(timestamptz, timestamptz, uuid) is
  'Per-person tablet sales for Team -> Sales: sales, cash and card in cents, each net of refunds, credited by the PIN on the sale (cash_sales.employee_id, kiosk_sales.employee_id via the KS code). A null employee_id row holds the sales nobody can be credited with. Owner only: anyone else gets no rows.';
