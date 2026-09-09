-- A PIN per sale, not per shift.
--
-- kiosks.pin_required locks the whole tablet until someone types a PIN, and it
-- stays unlocked until they tap Lock (no idle lock, by the owner's choice). So
-- it records who UNLOCKED the tablet, not who took the money: one person opens
-- the tablet at the start of a shift and every sale for the rest of it carries
-- their name, whoever actually rang it up.
--
-- pin_on_sale asks instead at the moment a sale begins, so the name on a sale is
-- the person who made it. It is independent of pin_required on purpose:
--   neither         the tablet is open, sales are unattributed (today's default)
--   pin_required    one PIN per shift, whole tablet locked
--   pin_on_sale     the tablet is open to look at, but no sale without a PIN
--   both            locked tablet AND a PIN per sale
--
-- Off by default, so no kiosk changes behaviour until the owner turns it on.
-- An app that does not know the field ignores it and behaves exactly as before.

alter table public.kiosks
  add column if not exists pin_on_sale boolean not null default false;

comment on column public.kiosks.pin_on_sale is
  'Ask for an employee PIN at the start of every sale, so the sale carries the person who made it. Independent of pin_required.';
