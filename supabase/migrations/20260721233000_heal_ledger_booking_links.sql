-- Self-heal for ledger rows that beat the booking sync.
--
-- A kiosk Stripe charge can reach stripe_transactions BEFORE its booking has
-- synced from Xano, so the webhook's name/booking lookup misses and the row
-- stays without customer_name / booking_id. The xano-booking-sync function
-- calls this after each batch (scoped to the refs it just upserted) to close
-- the gap; calling with NULL heals everything matchable.
--
-- SECURITY INVOKER: the service role (edge functions) bypasses RLS and heals;
-- app users have no UPDATE policy on stripe_transactions, so calling this as
-- a user updates nothing. Execute is revoked from client roles anyway.

create or replace function public.heal_ledger_booking_links(p_refs text[] default null)
returns integer
language sql
as $$
  with healed as (
    update public.stripe_transactions t
    set customer_name = coalesce(t.customer_name, c.full_name),
        booking_id = coalesce(t.booking_id, b.id)
    from public.bookings b
    join public.customers c on c.id = b.customer_id
    where t.object_type = 'charge'
      and (t.customer_name is null or t.booking_id is null)
      and t.booking_ref is not null
      and b.legacy_id = t.booking_ref
      and (p_refs is null or t.booking_ref = any(p_refs))
    returning t.id
  )
  select count(*)::int from healed;
$$;

comment on function public.heal_ledger_booking_links(text[]) is
  'Backfills customer_name + booking_id on charges whose booking (bookings.legacy_id = booking_ref) synced after the charge. NULL heals all matchable rows.';

revoke execute on function public.heal_ledger_booking_links(text[]) from anon, authenticated;
