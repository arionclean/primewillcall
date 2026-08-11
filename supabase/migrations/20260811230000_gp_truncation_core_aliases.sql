-- Groupon /gp: short "core" aliases that survive Groupon's title truncation.
--
-- Found by running 100 real vouchers from Xano's multimedia table through the
-- matcher. Truncation is the dominant failure mode, and it is not a fixed cut:
-- Groupon's app clips the deal title to the phone's width, so one deal arrives
-- as all of
--
--   "2 People: 90-Min Skyline Sunset Cruise with a Free Bottled Water!"
--   "2 People: 90-Min Skyline Sunset Cruise with a Free..."
--   "2 People: 90-Min Skyline Sunset Cruise with a Fre..."
--
-- and the Homes deal as "90-Minute The Homes of the Rich &..." on one phone and
-- "2 People: 90-Minute The Homes of t..." on another. Aliases written as the full
-- marketing title lose coverage as the cut gets earlier, and below 70% the fuzzy
-- tier gives up and the voucher falls to the model.
--
-- The fix is an alias short enough to survive the shortest observed cut. These
-- two carry no distinguishing word that a longer variant would contradict, so
-- they match every truncation of their deal without widening what else can hit.
-- Effect on the sample: the last 3 model-matched vouchers became deterministic,
-- taking the run to 100% deterministic (71 verbatim, 21 fuzzy, 6 merchant).

insert into tour_name_aliases (tour_id, raw_name, normalized_name, source)
select t.id,
       v.raw,
       lower(regexp_replace(v.raw, '[^a-zA-Z0-9]+', '', 'g')),
       'manual'
from tours t,
     (values ('90-Min Skyline Sunset Cruise'),
             ('90-Minute The Homes')) as v(raw)
where t.name = 'Miami Skyline Cruises'
  and not exists (
    select 1
    from tour_name_aliases a
    where a.tour_id = t.id
      and a.normalized_name = lower(regexp_replace(v.raw, '[^a-zA-Z0-9]+', '', 'g'))
  );
