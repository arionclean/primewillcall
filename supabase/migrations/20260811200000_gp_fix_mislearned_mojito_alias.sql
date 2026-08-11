-- Groupon /gp: move a mislearned alias off "Boat + Mojito".
--
-- The alias "Miami Sunset Cruise - 90 minute Sunset Cruise with the Mojito Bar
-- on Board!" was auto-learned (source = 'ai') onto the Boat + Mojito tour. That
-- title is a Miami Skyline Cruises sunset-cruise deal; Boat + Mojito is the $35
-- internal add-on, and Xano's catalog gives it exactly one name variation, its
-- own name. The learner almost certainly latched onto the word "Mojito".
--
-- It went unnoticed while Boat + Mojito accepted no Groupon vouchers. Once the
-- Xano-parity products were enabled it started colliding head-on with the real
-- Skyline alias: both scored 1.0 on the same voucher, the matcher declared the
-- two products ambiguous (correctly) and matched nothing, so a plain sunset
-- cruise stopped resolving at all.
--
-- The title itself is real, so it moves to the tour that actually sells it
-- rather than being deleted. The other nine 'ai' aliases were reviewed and are
-- on the right tours.

update tour_name_aliases a
set tour_id = (select id from tours where name = 'Miami Skyline Cruises')
where a.normalized_name = 'miamisunsetcruise90minutesunsetcruisewiththemojitobaronboard'
  and a.tour_id = (select id from tours where name = 'Boat + Mojito');
