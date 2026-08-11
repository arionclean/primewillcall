-- Groupon /gp: aliases for the "Homes of the Rich & Famous" Skyline deal.
--
-- Found by replaying 29 real vouchers from Xano's live request history. Two of
-- them (retried across 6 requests) are this deal, and Xano's own matcher scores
-- them 0.33 and 0.37 against its 0.45 threshold, so live Xano rejects them and
-- the customer is turned away.
--
-- The reason is that Groupon's app TRUNCATES the title in the voucher header:
-- the screen only ever shows "1 Person: 90-Minute The Homes of the Rich &...".
-- Every existing alias for this deal carries extra words the truncated line
-- never reaches ("Boat Tour", "Star Island Cruise", a year), and those are
-- distinguishing words, so the fuzzy tier rightly refused them.
--
-- These two aliases are the deal name as far as the voucher ever reveals it.
-- Neither contains a distinguishing word, so the visible fragment covers 4 of 5
-- tokens and matches. Verified: the three affected vouchers now resolve at the
-- fuzzy tier instead of falling through to the model.

insert into tour_name_aliases (tour_id, raw_name, normalized_name, source)
select t.id,
       v.raw,
       lower(regexp_replace(v.raw, '[^a-zA-Z0-9]+', '', 'g')),
       'manual'
from tours t,
     (values ('90-Minute The Homes of the Rich & Famous'),
             ('The Homes of the Rich & Famous')) as v(raw)
where t.name = 'Miami Skyline Cruises'
  and not exists (
    select 1
    from tour_name_aliases a
    where a.tour_id = t.id
      and a.normalized_name = lower(regexp_replace(v.raw, '[^a-zA-Z0-9]+', '', 'g'))
  );
