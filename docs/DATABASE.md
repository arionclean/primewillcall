# Database

Supabase project `qbnizuhozzwkiitfkjee`, schema `public`. The migrations under
`supabase/migrations/` are the source of truth; this file is the human-readable map.
Regenerate types after any schema change into `src/lib/supabase/database.types.ts`.

## Entity model

```
businesses ─┐
            ├─< business_tours >─ tours ─< tour_timeslots
            │        │               └─< tour_slot_closures
            │        │
            │        └─< tour_pax_tiers
            ├─< customers
            ├─< staff ─< staff_tours >─ tours
            └─< bookings >─ business_tours
                     │
                     └─ customers
```

- A `tour` is a Prime-owned master: capacity, timeslots, meeting point, instructions.
- A `business_tour` is one business's copy of a master tour (its own display `name` and
  `is_active`). Unique on `(tour_id, business_id)`.
- `tour_pax_tiers` hold pricing per `business_tour` (adult / child / infant, `price_cents`).
- `tour_timeslots` belong to the master `tour` and are shared by every business copy.
- A `booking` references one `business_tour` and one `customer`, stores `pax_adult/child/infant`,
  a `tour_pax_breakdown` jsonb snapshot, and `total_cents`.

## Tables

### businesses
`id uuid pk, name, slug, address?, phone?, contact_email?, timezone, logo_url?,
created_at, updated_at`
plus Stripe Connect fields: `stripe_account_id?` (the connected account `acct_...`),
`stripe_charges_enabled`, `stripe_payouts_enabled`, `stripe_details_submitted`,
`stripe_requirements_due`, and `stripe_account_synced_at?`. The platform (Prime) fee is a
single global rate, not per-business (env `STRIPE_PLATFORM_FEE_BPS`, default 25 bps =
0.25%). See "Payments (Stripe)" below.
One row per business Prime operates. Logos live in the `business-logos` storage bucket.
`phone` and `contact_email` are the support contacts guests see on the public
booking page (`/booking/<token>`).

### staff
`id uuid pk, user_id? (-> auth.users), business_id? (-> businesses), role enum,
full_name, email, phone?, is_active, can_create_bookings, can_edit_bookings,
can_check_in, can_delete_bookings, created_at, updated_at`
Role enum (`staff_role`): `owner`, `business_manager`, `check_in`. `owner` has no
`business_id`. A trigger links a new `auth.users` row to its `staff` row by email.

The four `can_*` booleans are per-staff booking permissions, editable by the owner
on `/admin/staff/[id]` ("Permissions"). Owners ignore them (always allowed); they
gate managers and check-in staff via the bookings RLS policies plus the
`bookings_enforce_update_capabilities` trigger (an account with `can_check_in` but
not `can_edit_bookings` may only change `checked_in_at` / `checked_in_by_staff_id`;
RLS alone cannot express column-level rules). Defaults: create/edit/check-in on,
delete off (new managers get delete on from the New team member form).

### tours (master, Prime-owned)
`id uuid pk, name, kind, capacity, notes?, instructions?, meeting_point_address?,
meeting_point_lat?, meeting_point_lng?, is_active, created_at, updated_at`

### tour_timeslots
`id uuid pk, tour_id (-> tours), start_time time, duration_minutes, sort_order,
is_active, created_at, updated_at` — unique `(tour_id, start_time)`.

### tour_slot_closures (per-date exceptions)
`id uuid pk, tour_id (-> tours), closed_on date, start_time time,
created_by? (-> staff), created_at` — unique `(tour_id, closed_on, start_time)`.
A row means "this departure is closed on this date" (weather, charter, sold out
offline). Open is the default: closing inserts, reopening deletes. Managed on the
`/availability` page; read by the public `/api/gp/*` endpoints so closed times
disappear from the Groupon page. Keyed by `start_time` (not timeslot id) on purpose:
the tour editor replaces timeslot rows wholesale and closures must survive that.
Existing bookings are not affected by a closure.

### business_tours (a business's copy of a tour)
`id uuid pk, tour_id (-> tours), business_id (-> businesses), name, is_active,
created_at, updated_at` — unique `(tour_id, business_id)`.

### tour_pax_tiers (pricing)
`id uuid pk, business_tour_id (-> business_tours), label, description?, price_cents,
currency, sort_order, is_active, created_at, updated_at`

### customers
`id uuid pk, business_id (-> businesses), full_name, email?, phone?,
stripe_customer_id?, notes?, created_at, updated_at`

### bookings
`id uuid pk, business_id, business_tour_id, customer_id, starts_at, ends_at,
status enum, total_cents, currency, pax_adult, pax_child, pax_infant,
tour_pax_breakdown jsonb, notes?, stripe_payment_intent_id?, created_by_staff_id?,
checked_in_at?, checked_in_by_staff_id?, source_channel?, groupon_redeemed_at?,
created_at, updated_at`
`status` is the payment lifecycle the app exposes: `confirmed` (normal, shown with
no tag), `pending` (shown as "Waiting for payment"), and `cancelled`. Bookings created
from `/schedule` start as `confirmed`. The enum (`booking_status`) also contains the
legacy values `checked_in` and `completed`; the app no longer writes them. Check-in is
tracked independently of status via `checked_in_at` (set/cleared by the check-in
toggle and the check-in API), so a guest can be checked in regardless of payment status.

`public_token` (UNIQUE, NOT NULL, default `generate_booking_token()`) identifies a
booking on the public booking page (`/booking/<token>`, no auth). Native bookings
get a random 10-char token from the column default. Xano-synced bookings carry the
9-char token Xano already emailed to the guest (`bookingConfirmation_id`, the slug
in `bked.io/booking/<token>` links), written by `xano-booking-sync`, so those links
keep working here after cutover. The differing lengths mean the two families can
never collide. No anon RLS: the page reads server-side with the service role, only
ever by exact token (the /gp pattern).

`legacy_id` (UNIQUE) is the sync dedup key for imported / synced bookings; native
in-app bookings leave it null. The `xano-booking-sync` function derives it as
`ota-<ProductBookingRef>` when an OTA Product booking ref is present (so the SAME
booking dedups to one row whether it arrives via the email connector or the Xano
webhook, and OTA status resends update rather than duplicate), else the Xano
`unique_id`, else `xano-<id>`. `legacy_reference` keeps the raw OTA ref but is NOT
unique (the bulk import also stored channel/payment placeholders like `Groupon` and
`kiosk-sale-card` there), so it is a label, never a dedup key.

### staff_tours
`staff_id, tour_id, created_at` — which tours a `check_in` staffer is assigned to.

### audit_log
`id bigint pk, occurred_at, actor_staff_id?, actor_kiosk_id?, entity, entity_id?,
action, payload jsonb` — append-only audit trail.

### Legacy / unused
`kiosk_tours` remains from the original schema but nothing in the app reads it. Slated for
removal once confirmed dead. Do not build on it. (`kiosks` is no longer dead: it now maps
each PrimeKiosk tablet to a business + Stripe Connect account. See "Payments (Stripe)" →
"Kiosk POS".)

## OTA email connector

The `email-booking-parse` edge function turns a raw OTA notification email (Bokun supplier
emails) into structured booking fields and resolves the product to a tour, without creating
a booking. See `supabase/functions/email-booking-parse` and migration
`20260610120000_email_connector.sql`.

### tour_name_aliases
`id, tour_id -> tours, normalized_name (unique), raw_name, source ('xano_seed' | 'ai' |
'manual'), created_at`. Maps a normalized OTA product title to a master tour for the
deterministic matcher (O(1) lookup on `normalized_name`). Seeded from Xano's
`products_variation.name_variations`; grows as the owner resolves queue rows. Read by any
active staff (the matcher itself runs as service role and bypasses RLS).

### email_match_queue
`id, status ('verify' | 'urgent' | 'resolved' | 'ignored'), reason ('ai_classified' |
'no_match' | 'needs_assignment'), original_product_name, supplier, booking_channel,
legacy_company_id, business_id? -> businesses, suggested_tour_id? -> tours, ai_confidence,
parsed jsonb, resolved_tour_id?, resolved_by_staff_id?, resolved_at, created_at`. Review
queue for emails the matcher could not place. The service-role function inserts (no insert
policy); owner sees all, manager sees their business. Surfaced on the owner-only
`/admin/unmatched` page.

### Functions
- `app_norm(text)` — shared normalizer (lowercase, strip non-alphanumeric); mirrors the JS
  `norm()` in the edge functions.
- `match_ota_tour(p_product, p_supplier, p_channel, p_company)` — deterministic resolver:
  product/supplier/channel -> master tour (alias table), email company -> operator business,
  `business_tour = (operator, tour)`. `business_tour_id` is null when the operator is not
  assigned the tour (the edge function then queues a `needs_assignment` row). SECURITY INVOKER.
- `resolve_email_match(p_queue_id, p_tour_id)` — owner/manager resolution: adds a name alias
  (teaches the matcher), assigns the tour to the operator if missing (creates the
  `business_tour` + clones pricing from an existing copy), marks the row resolved. SECURITY
  DEFINER with an internal owner / manager-by-business check.
- `ignore_email_match(p_queue_id)` — dismiss a queued row. Same auth check.

## Groupon convenience fee (public /gp page)

`/gp` is a public, unauthenticated page where a Groupon customer uploads a voucher
photo, the product is matched, and a `pending` ("waiting for payment") booking is
created on the `groupon` channel. It is the Supabase-native rebuild of the legacy
Bubble/Xano voucher widget. Payment now runs through Stripe (see "Payments (Stripe)"):
the pending booking is created, then a Checkout Session collects the convenience fee. If
the business is not yet onboarded to Stripe, it gracefully falls back to the pre-Stripe
behavior (booking held, fee collected manually).

### Schema
- `business_tours.groupon_fee_cents` (int, nullable) — the owner-managed per-passenger
  convenience fee for that product. `NULL` = the product does not accept Groupon;
  `0` = offered free. Owners edit this on the owner-only `/admin/groupon` page.
- `gp-vouchers` storage bucket (public read) — the uploaded voucher photos. Writes are
  done server-side with the service role, so there is no anon insert policy.
- `groupon_candidates()` — SECURITY DEFINER RPC returning the Groupon-enabled
  `business_tours` (fee not null, active) joined to business + tour, with each tour's
  `tour_name_aliases` as a `text[]`. The validator feeds this small candidate set to the
  vision model; the fee always comes from this row, never from the model.

### Request flow (all server-side, service role; no anon DB access)
- `POST /api/gp/validate` — uploads the photo to `gp-vouchers`, then hands the public URL
  to the `gp-voucher-vision` edge function and returns
  `{ valid, businessTourId, productName, feeCents, passengers, voucherCode, imageUrl }`.
  The edge function ports the Xano vision_v3 chain (~1.5s avg there): Google Cloud Vision
  TEXT_DETECTION OCR (`GOOGLE_API_KEY`), Groq llama-4-scout vision as OCR fallback, a
  deterministic alias/product-name substring match (zero AI in the common case), and Groq
  `openai/gpt-oss-120b` for passenger + redemption-code extraction (the "1 of 1 = one
  voucher, not one passenger" trap is handled in the prompt; OpenAI is the extraction
  fallback). AI keys live as **Supabase function secrets**, not app env. Deployed with
  verify_jwt on; the route calls it with the service role key. If the function is
  unreachable the route degrades to a graceful "couldn't read the voucher".
- `GET /api/gp/slots?business_tour_id&date` — active `tour_timeslots` for the matched
  product's master tour, past times hidden for today (NY), minus any
  `tour_slot_closures` for that date. Replaces Xano `manage_slots`.
- `POST /api/gp/book` — re-validates the product + fee (and rejects a time closed for
  that date), creates the customer
  (`legacy_source = 'groupon'`) and a `pending` booking (`source_channel = 'groupon'`,
  `legacy_reference = <voucher code>`, `total_cents = fee × passengers`, the fee as a
  `tour_pax_breakdown` line), then (when the business is Stripe-onboarded) creates a
  Checkout Session and returns its URL; otherwise returns the manual-collection fallback.

## Payments (Stripe)

Supabase-native replication of the live Xano Stripe model, so we are ready to migrate off
Xano (Xano itself is never written to). Model: **Stripe Connect with direct charges**. Each
business is a connected account (`businesses.stripe_account_id`); a charge is created
**on** that account with a platform `application_fee_amount` (Prime's cut). The business is
merchant of record; Prime skims the fee. This matches how the existing (Xano-era) accounts
were onboarded. Use Prime's PLATFORM secret key (env `STRIPE_SECRET_KEY`), the same account
whose connected accounts back each business.

### Tables
- `stripe_transactions` — the payment ledger, one row per Stripe charge / payment_intent,
  deduped on `stripe_id`. Columns include `business_id`, `connected_account_id`,
  `charge_type` (`direct` | `destination`), `amount`/`application_fee`/`stripe_fee`/`net`/
  `amount_refunded` (all cents), `status`, `dispute_status`, `source`, `booking_id` +
  `booking_ref` (from `metadata.booking_id`), `receipt_url`, `stripe_created`, and the full
  `raw` jsonb. Populated by the webhook from `charge.*` events; `net`/`stripe_fee` come from
  the charge's balance transaction (a gap the Xano webhook left at 0).
- `stripe_refunds` — refund ledger (`stripe_refund_id`, `transaction_id`, `business_id`,
  `booking_id`, `amount`, `reason`, `status`, `created_by_staff_id`, `raw`). Written by the
  refund action (below); the webhook `charge.refunded` reconciles the transaction totals.
- `stripe_events` — webhook idempotency + audit (`id` = Stripe `evt_...`, `type`, `account`,
  `payload`, `received_at`, `processed_at`, `error`).
- `cash_sales` — the PrimeKiosk tablet's cash ledger (`business_id`, `kiosk_id`,
  `booking_id`/`booking_ref`, `amount_cents`, `type`, `product`, `status`, `kiosk_slug`).
  Card kiosk sales need no table: a Terminal PaymentIntent is a direct charge, so the webhook
  records it into `stripe_transactions` with `source='kiosk'`.
- `kiosks` (Kiosk POS columns) — `business_id`, `slug` (the tablet's login tag; unique),
  `stripe_account_id` (optional per-kiosk Connect override), `terminal_location_id`,
  `simulated`. Maps a tablet to the connected account its sales settle on.

### RPC
- `stripe_payments_summary(p_start, p_end)` — gross / net / stripe_fees / application_fees /
  refunded / count for a date range, `SUM`'d in the DB. `SECURITY INVOKER`, so
  `stripe_transactions` RLS still scopes the totals by business. Backs the `/admin/payments`
  summary cards (never sum the ledger in JS: the 1000-row read cap would truncate).

### RLS
`stripe_transactions` / `stripe_refunds`: SELECT for `owner` (all) and `business_manager`
(own `business_id`); no INSERT/UPDATE/DELETE policies (the webhook + server actions write
with the service role, which bypasses RLS). `cash_sales`: SELECT for `owner` (all) and
`business_manager` + `check_in` (own `business_id`); the kiosk route writes with the service
role. `stripe_events`: RLS on, no policies (service-role only).

### Flow
- **Connect onboarding** (`/admin/businesses/[id]`, owner): create the connected account,
  hosted onboarding link, Express-dashboard login link, refresh status, an owner-only
  "link existing `acct_...`" field (attaches already-onboarded businesses with no
  re-onboarding, no Xano access). Server actions in `[id]/payments-actions.ts`; webhook
  `account.updated` keeps the status flags in sync. The platform fee is a single global rate
  (`STRIPE_PLATFORM_FEE_BPS`, default 25 bps = 0.25%), applied as the application fee on
  every direct charge.
- **Webhook** (`/api/stripe/webhook`, Next.js route, `nodejs` runtime): one endpoint for
  both platform and Connect deliveries (two dashboard endpoints, two signing secrets:
  `STRIPE_WEBHOOK_SECRET` + `STRIPE_WEBHOOK_SECRET_CONNECTED`). Uses the official
  `constructEvent` verifier. Handles `checkout.session.completed` / `payment_intent.succeeded`
  (flip booking to `confirmed`, set `paid_at` + `stripe_payment_intent_id`), `charge.*`
  (upsert the ledger), `charge.dispute.*`, and `account.updated`.
- **Booking link**: every charge carries `metadata.booking_id` + `metadata.source` (set on
  both the session and `payment_intent_data` so the CHARGE carries it). The webhook resolves
  `booking_id` and `business_id` (via `connected_account_id`) into the ledger row. `bookings`
  gains `paid_at`; the existing `stripe_payment_intent_id` is set on payment.
- **Payments dashboard** (`/admin/payments`, owner + `business_manager`; `check_in` is
  redirected out since it has no ledger read): a charges table (date range + owner business
  filter, most-recent 200 in range) plus summary cards from `stripe_payments_summary`.
- **Refund** (`admin/payments/actions.ts`): owner or the charge's `business_manager`; creates
  the refund on the connected account (direct charge), records `stripe_refunds` with the
  acting staff, and optimistically updates the transaction (the `charge.refunded` webhook
  reconciles). `source='online'|'groupon'|'kiosk'` charges are all refundable here.
- **Customer payment link** (`POST /api/bookings/[id]/payment-link`): staff mint a Checkout
  link for a booking (RLS authorizes the read, direct charge on the business's account with
  the platform fee) and send it to the customer; surfaced by the "Payment link" button in the
  booking edit modal.
- **Kiosk POS (Stripe Terminal)**: `POST /api/kiosk/connection-token` (Terminal connection
  token) + `POST /api/kiosk/payment-intent` (`card_present` direct charge with the platform
  fee) for the PrimeKiosk tablet. Both resolve the connected account server-side from the
  tablet's `kiosk` tag (`kiosks.slug`, via `src/lib/kiosk/resolve.ts`), so the caller can
  never pick the account. Card sales land in `stripe_transactions` (`source='kiosk'`) through
  the webhook; cash sales write `cash_sales`. Still needs go-live config (real Terminal
  Locations + kiosk->business mappings) and the tablet pointed here.

### Out of scope (follow-ups; schema already laid)
Taking payment inline in the internal `/schedule` new-booking flow, and saved-customer flows
(`customers.stripe_customer_id` is still a placeholder). Go-live config (platform key,
register the two webhook endpoints, connect each business, Terminal Locations) is the
remaining operational step.

### Marking a voucher redeemed
The owner still redeems each voucher on Groupon's own platform (the photo/code the
guest uploaded is kept in the booking's `notes`). Once done, they record it here via
`bookings.groupon_redeemed_at` (nullable timestamp, mirrors `checked_in_at`): the
bookings list shows an owner-only "Redeem" / "Redeemed" toggle on `source_channel =
'groupon'` rows. Independent of check-in and payment status; no RLS change (owner
already has full booking access).

## Access control (RLS)

RLS is enabled on all app tables. Every policy is expressed through the
`current_staff()` SECURITY DEFINER function, which returns the caller's
`(staff_id, role, business_id)`. This avoids recursive policy lookups on `staff`.

General shape:

- **owner**: full access to everything.
- **business_manager**: read + write rows belonging to their `business_id`
  (`bookings`, `customers`, `business_tours`, `tour_pax_tiers` via the parent business).
- **check_in**: read `business_tours` / `tour_pax_tiers` for their business; read,
  insert and update `bookings` only for tours they are assigned to via `staff_tours`
  (each write also gated by the `staff.can_*` capability columns). Can insert
  `customers` for their business. Delete only when `can_delete_bookings` is on.

Table-specific notes:

- `tours` / `tour_timeslots`: all roles can read; only `owner` can write. (Timeslots are
  shared, so managers never edit schedules.)
- `tour_slot_closures`: all roles can read; insert/delete is owner, or a manager whose
  business is assigned to the tour (`business_tours`). Closing affects every business
  sharing the departure, which mirrors reality: the boat itself is not going out.
- `customers`: owner + manager + check-in of the business can insert and read; update is
  owner + manager; delete is owner only.
- `bookings`: all non-owner writes are capability-gated by the `staff.can_*` columns.
  Insert: owner; manager (own business); check-in (own business + assigned tour), each
  needing `can_create_bookings`. Update: same row scopes, needing `can_edit_bookings`
  or `can_check_in` (the trigger limits check-in-only accounts to the check-in stamp).
  Delete: owner, or manager / check-in with `can_delete_bookings`.
- `bookings_checkin_manifest(p_start, p_end)` — SECURITY INVOKER RPC: per-`starts_at`
  remaining-to-check-in pax + total pax for a day window, cancelled excluded, aggregated
  in the DB. RLS scopes it (check-in staff count only their assigned tours). Backs the
  sidebar Manifest that check-in accounts see (`components/app/sidebar-manifest.tsx`),
  which live-refreshes off a bookings Realtime subscription.
- `business_tours` / `tour_pax_tiers`: owner full; manager read + write for their
  business; check-in read only.

When something returns no rows or a write silently fails, it is almost always RLS.
Verify the caller's role/business with `/dashboard/debug` and compare against the policy.

## Conventions

- UUID primary keys (`gen_random_uuid()`); `bigint identity` only for `audit_log`.
- Timestamps are `timestamptz`; `created_at` / `updated_at` on every table.
- Money is integer `*_cents`; never floats.
- Business operating timezone is `America/New_York` (see `businesses.timezone`).
