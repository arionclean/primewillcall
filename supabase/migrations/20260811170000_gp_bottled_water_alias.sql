-- Groupon /gp: alias for the live "Free Bottled Water" Skyline deal.
--
-- Every voucher currently sitting in the gp-vouchers bucket is this deal:
--   "<N> People: 90-Min Skyline Sunset Cruise with a Free Bottled Water!"
--   Miami Skyline Cruises
-- The title was never in tour_name_aliases, so the deterministic tiers found
-- nothing and every one of these vouchers had to be resolved by the model. It is
-- the same boat product as the mojito-bar deals, just a different Groupon offer.
--
-- Verbatim matching still cannot catch it: Groupon renders the "1 of 3" voucher
-- count inside the title line, so the OCR text reads "...Skyline Sunset1 of 3
-- Cruise with...". The fuzzy tier strips that count and matches on the words.

insert into tour_name_aliases (tour_id, raw_name, normalized_name, source)
select t.id,
       '90-Min Skyline Sunset Cruise with a Free Bottled Water!',
       '90minskylinesunsetcruisewithafreebottledwater',
       'manual'
from tours t
where t.name = 'Miami Skyline Cruises'
  and not exists (
    select 1
    from tour_name_aliases a
    where a.tour_id = t.id
      and a.normalized_name = '90minskylinesunsetcruisewithafreebottledwater'
  );
