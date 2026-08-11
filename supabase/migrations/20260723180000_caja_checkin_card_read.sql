-- Caja (seller money view): let check-in staff read their own business's kiosk
-- CARD sales so the /caja screen can show "how much did I make" and each card
-- sale's status next to the cash they already see.
--
-- Today stripe_transactions is owner + business_manager only (see
-- 20260709120000_stripe_payments.sql). Cash is already visible to check_in via
-- cash_sales_select. This adds a second, narrow SELECT policy: check_in reads
-- ONLY kiosk-source charges (source = 'kiosk') for their own business. It never
-- exposes online or Groupon charges to desk staff, only the tablet sales that
-- are their own takings. Permissive policies are OR'd, so owner / manager access
-- is unchanged.
--
-- SELECT only. The webhook and server actions keep writing with the service role
-- (which bypasses RLS), so no write policy is added.

drop policy if exists stripe_transactions_select_checkin_kiosk on public.stripe_transactions;
create policy stripe_transactions_select_checkin_kiosk
  on public.stripe_transactions
  for select to authenticated
  using (
    source = 'kiosk'
    and exists (
      select 1 from public.current_staff() cs
      where cs.role = 'check_in'
        and cs.business_id = stripe_transactions.business_id
    )
  );
