-- The business an OTA booking belongs to follows the PRODUCT, not the mailbox the
-- email happened to be addressed to. This mirrors what the live stack actually does.
--
-- Xano's email connector (principal_v3_product_booking_ref_v2) identifies the product,
-- fetches it from Bubble, and answers with `$product_selected.company`: the company
-- that owns the product. The company Make computes from the recipients is passed in as
-- a lookup constraint only and never becomes the answer. So an email sent to the Key
-- West mailbox for a Miami product is a MIAMI booking, which is what Xano has stored
-- for every such booking we compared (e.g. KEY-T147293210, KEY-T147167430).
--
-- Here a Bubble product is a `business_tours` row carrying `legacy_product_id`, which
-- already names both the tour and its owning business. Every tour that has one has
-- exactly one, so it is an unambiguous owner.
--
-- The email company stays as the fallback, for a tour with no Bubble product behind it
-- (anything created natively here). That keeps the previous behaviour where there is
-- nothing better to go on.

create or replace function public.match_ota_tour(
  p_product text, p_supplier text, p_channel text, p_company text
)
returns table(tour_id uuid, tour_name text, business_id uuid, business_tour_id uuid, method text)
language sql
stable
set search_path to 'pg_catalog', 'public'
as $function$
  with hit as (
    select a.tour_id,
      case
        when a.normalized_name = public.app_norm(p_product) then 'product'
        when a.normalized_name = public.app_norm(p_supplier) then 'supplier'
        else 'channel'
      end as method,
      case
        when a.normalized_name = public.app_norm(p_product) then 0
        when a.normalized_name = public.app_norm(p_supplier) then 1
        else 2
      end as pri
    from public.tour_name_aliases a
    where a.normalized_name = public.app_norm(p_product)
       or (p_supplier is not null and a.normalized_name = public.app_norm(p_supplier))
       or (p_channel is not null and a.normalized_name = public.app_norm(p_channel))
    order by pri
    limit 1
  ),
  -- The product's owner: the business whose copy of this tour is the Bubble product.
  owner as (
    select bt.id, bt.business_id
    from public.business_tours bt
    join hit h on h.tour_id = bt.tour_id
    where bt.legacy_product_id is not null
    limit 1
  ),
  -- Fallback only: the business behind the email's company id.
  biz as (
    select id from public.businesses where legacy_company_id = p_company limit 1
  )
  select h.tour_id,
         t.name,
         coalesce(o.business_id, b.id),
         coalesce(o.id, bt.id),
         h.method
  from hit h
  join public.tours t on t.id = h.tour_id
  left join owner o on true
  left join biz b on true
  left join public.business_tours bt
    on bt.tour_id = h.tour_id and bt.business_id = b.id;
$function$;
