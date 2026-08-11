-- Groupon /gp: merchant gate for the voucher matcher.
--
-- Replaying real Xano traffic surfaced a false positive: a voucher for
-- "Skyline & Coast Cruise" sold by "N.Y.C Skyline Tours & Cruises", a New York
-- operator with no relationship to Prime, was matched to Miami Skyline Cruises
-- and would have created a Miami booking and charged the fee. Live Xano rejected
-- it correctly, because it gates on the storefront name before matching at all.
--
-- Xano hardcodes four storefront names in the function stack. Here they are data
-- so the owner can add one without a deploy. A storefront is not always a
-- business: Groupon sells the same operator under several names, and only two of
-- the four are real businesses.
--
--   Miami Skyline Cruises      -> business name
--   Key West Sightseeing Tours -> business name
--   Miami Star Island Cruises  -> storefront of Miami Skyline Cruises
--   Miami Tour Bus             -> storefront of Miami Skyline Cruises
--
-- The gate applies only to the AI fallback in gp-voucher-vision. The
-- deterministic tiers already require one of our own product titles to appear in
-- the voucher, which is evidence in itself, and gating them would throw away
-- legitimate vouchers whose photo is too poor for the storefront line to be read.
-- The model is the tier that free-associates, and it is where the bad match came
-- from.

alter table public.businesses
  add column if not exists groupon_merchant_names text[] not null default '{}'::text[];

comment on column public.businesses.groupon_merchant_names is
  'Extra Groupon storefront names this business sells under, beyond businesses.name. Used to gate /gp voucher matching.';

update public.businesses
set groupon_merchant_names = array['Miami Star Island Cruises', 'Miami Tour Bus']
where name = 'Miami Skyline Cruises'
  and groupon_merchant_names = '{}'::text[];

-- Return type changes, so the function has to be dropped rather than replaced.
drop function if exists public.groupon_candidates();

create or replace function public.groupon_candidates()
returns table (
  business_tour_id uuid,
  business_id uuid,
  business_name text,
  merchant_names text[],
  tour_id uuid,
  tour_name text,
  product_name text,
  groupon_fee_cents integer,
  aliases text[]
)
language sql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $$
  select bt.id, b.id, b.name,
    array[b.name] || coalesce(b.groupon_merchant_names, '{}'::text[]),
    t.id, t.name, bt.name, bt.groupon_fee_cents,
    coalesce(
      array(
        select a.raw_name
        from public.tour_name_aliases a
        where a.tour_id = t.id and a.raw_name is not null
      ),
      '{}'::text[]
    )
  from public.business_tours bt
  join public.businesses b on b.id = bt.business_id
  join public.tours t on t.id = bt.tour_id
  where bt.groupon_fee_cents is not null
    and bt.is_active = true
    and t.is_active = true;
$$;

grant execute on function public.groupon_candidates() to anon, authenticated, service_role;
