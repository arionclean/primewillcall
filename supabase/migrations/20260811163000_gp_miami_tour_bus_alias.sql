-- Groupon /gp: recognize the "Miami Tour Bus" merchant name.
--
-- Xano's live voucher matcher (vision_v4) gates on four Groupon merchant names:
-- Miami Skyline Cruises, Miami Star Island Cruises, Miami Tour Bus, and
-- Key West Sightseeing Tours. Only two of those are real businesses; the other
-- two are storefront names Groupon prints on the voucher.
--
-- "Miami Star Island Cruises" is already an alias on the Miami Skyline Cruises
-- tour. "Miami Tour Bus" had no alias at all, so a voucher whose only readable
-- product line was that merchant name failed to match on /gp while Xano matched
-- it. It maps to the bus product, Miami 5 in 1 City Tour.
--
-- normalized_name follows the same rule as the matcher: lowercase, non
-- alphanumerics stripped.

insert into tour_name_aliases (tour_id, raw_name, normalized_name, source)
select t.id, 'Miami Tour Bus', 'miamitourbus', 'manual'
from tours t
where t.name = 'Miami 5 in 1 City Tour'
  and not exists (
    select 1
    from tour_name_aliases a
    where a.tour_id = t.id
      and a.normalized_name = 'miamitourbus'
  );
