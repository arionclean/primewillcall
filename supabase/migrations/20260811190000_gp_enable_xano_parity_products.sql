-- Groupon /gp: enable the remaining products at Xano's live fees.
--
-- Xano's live matcher (vision_v4) accepts all ten products in its catalog and
-- charges a flat $4.99, with Jet Ski free. Only three products were enabled
-- here, so a real voucher for any of the other seven was rejected on /gp while
-- Xano booked it. That gap makes a shadow comparison against live Xano traffic
-- unreadable: every one of those would score as a disagreement that is really
-- just missing configuration.
--
-- Business assignment follows Xano's products_variation.company: nine products
-- belong to Miami Skyline Cruises and only Key West Day Trips belongs to Key
-- West Sightseeing Tours. Supabase carries duplicate business_tours rows of each
-- product under both businesses, so enabling the Xano-correct one keeps exactly
-- one Groupon-enabled row per product. Two would make the matcher ambiguous
-- about which business gets the booking and the fee.
--
-- Guarded on `is null` so it only fills products the owner never configured. The
-- three already set (including Miami 5 in 1 City Tour, deliberately $0 here
-- against Xano's $4.99) are left exactly as the owner set them in /admin/groupon.

update business_tours bt
set groupon_fee_cents = case when t.name = 'Jet Ski' then 0 else 499 end
from tours t, businesses b
where t.id = bt.tour_id
  and b.id = bt.business_id
  and b.name = 'Miami Skyline Cruises'
  and bt.groupon_fee_cents is null
  and t.name in (
    'Everglades Tour',
    'Jet Ski',
    'Miami Party Cruises',
    'Miami City Tour combo',
    'Boat + Mojito',
    'Boat + Empanada',
    'Transportation'
  );
