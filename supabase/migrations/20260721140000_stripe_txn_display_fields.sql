-- Payments ledger display fields.
--
-- The /admin/payments table needs what the legacy Xano view showed per charge:
-- the customer's name, the card last4, and where the sale happened (kiosk1,
-- kiosk3, online, groupon). All of it already arrives in the webhook payload
-- (stored in `raw`); this promotes the pieces into real columns and backfills
-- existing rows.
--
--   customer_name  <- billing_details.name (online checkout; card_present has none)
--   card_last4     <- payment_method_details.{card,card_present,interac_present}.last4
--   source         <- our own metadata.source when present (groupon/schedule),
--                     else Xano's metadata.kiosk tag (kiosk1..kiosk4),
--                     else 'online' (Xano's online widget sets no metadata)

alter table public.stripe_transactions
  add column if not exists customer_name text,
  add column if not exists card_last4 text;

comment on column public.stripe_transactions.customer_name is
  'Cardholder name from billing_details.name (null for card_present kiosk sales).';
comment on column public.stripe_transactions.card_last4 is
  'Card last4 from payment_method_details (card, card_present, or interac_present).';

update public.stripe_transactions
set
  customer_name = coalesce(
    customer_name,
    nullif(raw -> 'billing_details' ->> 'name', '')
  ),
  card_last4 = coalesce(
    card_last4,
    raw -> 'payment_method_details' -> 'card' ->> 'last4',
    raw -> 'payment_method_details' -> 'card_present' ->> 'last4',
    raw -> 'payment_method_details' -> 'interac_present' ->> 'last4'
  ),
  source = coalesce(
    source,
    raw -> 'metadata' ->> 'kiosk',
    'online'
  )
where object_type = 'charge';
