-- Caja, per kiosk. The check-in login IS the kiosk (they are the same account;
-- the Xano/Supabase split is only a migration artifact). Each account carries its
-- own kiosk_slug and sees ONLY that kiosk's cash + card, so the end-of-night
-- drawer reconciles per tablet.
--
-- Why per-kiosk and not per-business: one business can run several kiosks — e.g.
-- "Miami Skyline Cruises" has both kiosk2 and kiosk3 — so business-level scoping
-- would show one desk another desk's takings and neither drawer would match.
--
-- Supersedes 20260723180000, whose draft policy filtered source = 'kiosk' (a
-- literal that matches no rows: real sources are kiosk1..kioskN).

-- 1. The account's kiosk identity. Nullable: only check-in (kiosk) logins have
--    one; owners and managers do not. Going forward, set this when creating a
--    kiosk account; the backfill below covers the four already-migrated kiosks.
alter table public.staff add column if not exists kiosk_slug text;
comment on column public.staff.kiosk_slug is
  'For check-in (kiosk) logins: the kiosks.slug this account sells as. Scopes /caja to its own takings.';

-- 2. Backfill the migrated kiosks from the existing naming convention
--    (full_name "Kiosk3" -> slug "kiosk3"), matched inside the same business so
--    two same-named desks can never cross-link.
update public.staff s
   set kiosk_slug = k.slug
  from public.kiosks k
 where s.role = 'check_in'
   and s.kiosk_slug is null
   and k.business_id = s.business_id
   and k.slug = lower(replace(s.full_name, ' ', ''));

-- 3. The caller's own kiosk slug, resolved once, SECURITY DEFINER so a policy can
--    use it without recursing through staff's own RLS (same pattern as
--    current_staff()). Returns NULL for anyone who is not an active check-in
--    login, which makes the equality checks below fail closed.
create or replace function public.current_kiosk_slug()
  returns text
  language sql
  stable security definer
  set search_path to 'pg_catalog', 'public'
as $function$
  select s.kiosk_slug
  from public.staff s
  where s.user_id = auth.uid()
    and s.role = 'check_in'
    and s.is_active = true
  limit 1
$function$;

-- 4. Card. Replace the business-wide draft with a per-kiosk read: a check-in
--    staffer sees only stripe charges whose source = their own kiosk_slug. Owner
--    and business_manager keep their existing (separate) policies untouched —
--    permissive policies are OR'd. SELECT only; the webhook writes as service role.
drop policy if exists stripe_transactions_select_checkin_kiosk on public.stripe_transactions;
create policy stripe_transactions_select_checkin_kiosk
  on public.stripe_transactions
  for select to authenticated
  using ( stripe_transactions.source = public.current_kiosk_slug() );

-- 5. Cash. Tighten the check-in branch from business-wide to its own kiosk_slug.
--    Owner (every business) and business_manager (their business) are unchanged.
drop policy if exists cash_sales_select on public.cash_sales;
create policy cash_sales_select
  on public.cash_sales
  for select to authenticated
  using (
    exists (
      select 1 from public.current_staff() cs
      where cs.role = 'owner'
         or (cs.role = 'business_manager' and cs.business_id = cash_sales.business_id)
    )
    or cash_sales.kiosk_slug = public.current_kiosk_slug()
  );
