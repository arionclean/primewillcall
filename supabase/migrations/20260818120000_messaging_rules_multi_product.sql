-- Trigger products: one automation can now target SEVERAL products.
--
-- Was: messaging_rules.business_tour_id, a single product, NULL meaning "any
-- product". That could say "this one product" or "all of them" and nothing in
-- between, so an owner who wanted three of the twenty products had to build the
-- same automation three times.
--
-- Now: messaging_rules.business_tour_ids uuid[]. NULL or empty still means "any
-- product", so the two ends of the range are unchanged and every existing rule
-- keeps its behaviour. The backfill wraps each single id into a one-element
-- array before the old column goes away.
--
-- Trade-off: an array cannot carry a foreign key, so deleting a business_tour
-- leaves its id behind in any array that named it. That is harmless (the id
-- simply never matches a booking again, and the picker only renders products it
-- can still resolve), and it is the price of keeping the rule readable in one
-- row instead of adding a join table for a set that is almost always tiny.
--
-- Written to be re-runnable. This change reached the shared project ahead of
-- the code, so the columns may already be in their final state; each step is
-- guarded so applying it twice is a no-op rather than an error.

alter table public.messaging_rules
  add column if not exists business_tour_ids uuid[];

-- Backfill only while the old column is still there.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'messaging_rules'
      and column_name = 'business_tour_id'
  ) then
    update public.messaging_rules
    set business_tour_ids = array[business_tour_id]
    where business_tour_id is not null
      and business_tour_ids is null;
  end if;
end
$$;

alter table public.messaging_rules
  drop column if exists business_tour_id;

comment on column public.messaging_rules.business_tour_ids is
  'Products this automation fires for. NULL or empty array = any product.';
