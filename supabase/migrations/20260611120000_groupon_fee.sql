-- Groupon convenience-fee feature (the public /gp voucher-redemption page).
--
-- 1. A per-product fee column on business_tours: the owner-managed amount charged
--    to a Groupon customer who redeems a voucher for that product. NULL means the
--    product does not accept Groupon self-service; 0 means it is offered for free.
-- 2. A public gp-vouchers storage bucket for the uploaded voucher photos (modeled
--    on the business-logos bucket). Public read so the page can show the image;
--    writes happen server-side with the service role, which bypasses storage RLS,
--    so there is no anon insert policy.
-- 3. groupon_candidates(): the Groupon-enabled products plus their name aliases.
--    The public /gp validator feeds this small candidate set to the vision model
--    to match an uploaded voucher to a product, then reads the fee from here.

alter table public.business_tours
  add column if not exists groupon_fee_cents integer
  check (groupon_fee_cents is null or groupon_fee_cents >= 0);

comment on column public.business_tours.groupon_fee_cents is
  'Per-passenger Groupon convenience fee in cents. NULL = Groupon self-service not offered for this product; 0 = offered free.';

-- ── gp-vouchers storage bucket ────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'gp-vouchers',
  'gp-vouchers',
  true,
  10485760, -- 10 MB
  array['image/png','image/jpeg','image/jpg','image/webp']::text[]
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists gp_vouchers_select on storage.objects;
create policy gp_vouchers_select on storage.objects
  for select to public
  using (bucket_id = 'gp-vouchers');

-- ── Groupon-enabled products + aliases for the voucher matcher ─────────────────
create or replace function public.groupon_candidates()
returns table (
  business_tour_id uuid,
  business_id uuid,
  business_name text,
  tour_id uuid,
  tour_name text,
  product_name text,
  groupon_fee_cents integer,
  aliases text[]
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select bt.id, b.id, b.name, t.id, t.name, bt.name, bt.groupon_fee_cents,
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
