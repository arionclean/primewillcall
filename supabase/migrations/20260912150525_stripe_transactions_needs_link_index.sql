-- heal_ledger_booking_links fills the booking + guest name onto a Stripe charge
-- that arrived before its booking row existed. It is called after every Xano sync
-- batch and every kiosk card sale: 45,288 calls at ~46 ms, 3.9% of all database
-- time, and it almost always finds nothing (17 of 4,754 charges still need it).
--
-- It was sequential-scanning all 4,754 charges every call. This partial index
-- holds ONLY the rows that still need healing, so the function finds them (or
-- finds nothing) in one lookup. A row leaves the index the moment it is healed,
-- so the index stays tiny on its own.
--
-- Nothing about the healing changes: same function, same rows, same result.
-- Charges keep getting linked the instant their booking appears.

create index if not exists stripe_transactions_needs_link_idx
  on public.stripe_transactions (booking_ref)
  where object_type = 'charge'
    and (customer_name is null or booking_id is null);
