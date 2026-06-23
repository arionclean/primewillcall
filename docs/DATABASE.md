# Database

Supabase project `qbnizuhozzwkiitfkjee`, schema `public`. The migrations under
`supabase/migrations/` are the source of truth; this file is the human-readable map.
Regenerate types after any schema change into `src/lib/supabase/database.types.ts`.

## Entity model

```
businesses ─┐
            ├─< business_tours >─ tours ─< tour_timeslots
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
`id uuid pk, name, slug, address?, phone?, timezone, logo_url?, created_at, updated_at`
One row per business Prime operates. Logos live in the `business-logos` storage bucket.

### staff
`id uuid pk, user_id? (-> auth.users), business_id? (-> businesses), role enum,
full_name, email, phone?, is_active, created_at, updated_at`
Role enum (`staff_role`): `owner`, `business_manager`, `check_in`. `owner` has no
`business_id`. A trigger links a new `auth.users` row to its `staff` row by email.

### tours (master, Prime-owned)
`id uuid pk, name, kind, capacity, notes?, instructions?, meeting_point_address?,
meeting_point_lat?, meeting_point_lng?, is_active, created_at, updated_at`

### tour_timeslots
`id uuid pk, tour_id (-> tours), start_time time, duration_minutes, sort_order,
is_active, created_at, updated_at` — unique `(tour_id, start_time)`.

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
checked_in_at?, checked_in_by_staff_id?, created_at, updated_at`
`status` is the payment lifecycle the app exposes: `confirmed` (normal, shown with
no tag), `pending` (shown as "Waiting for payment"), and `cancelled`. Bookings created
from `/schedule` start as `confirmed`. The enum (`booking_status`) also contains the
legacy values `checked_in` and `completed`; the app no longer writes them. Check-in is
tracked independently of status via `checked_in_at` (set/cleared by the check-in
toggle and the check-in API), so a guest can be checked in regardless of payment status.

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
`kiosks` and `kiosk_tours` remain from the original schema but nothing in the app reads
them. Slated for removal once confirmed dead. Do not build on them.

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
Bubble/Xano voucher widget. Payment (Stripe) is the final migration phase and is
currently stubbed (the booking is created, the charge is not).

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
  product's master tour, past times hidden for today (NY). Replaces Xano `manage_slots`.
- `POST /api/gp/book` — re-validates the product + fee, creates the customer
  (`legacy_source = 'groupon'`) and a `pending` booking (`source_channel = 'groupon'`,
  `legacy_reference = <voucher code>`, `total_cents = fee × passengers`, the fee as a
  `tour_pax_breakdown` line). Stripe is stubbed.

## Access control (RLS)

RLS is enabled on all app tables. Every policy is expressed through the
`current_staff()` SECURITY DEFINER function, which returns the caller's
`(staff_id, role, business_id)`. This avoids recursive policy lookups on `staff`.

General shape:

- **owner**: full access to everything.
- **business_manager**: read + write rows belonging to their `business_id`
  (`bookings`, `customers`, `business_tours`, `tour_pax_tiers` via the parent business).
- **check_in**: read `business_tours` / `tour_pax_tiers` for their business; read +
  update `bookings` only for tours they are assigned to via `staff_tours`. Can insert
  `customers` for their business. Cannot delete bookings.

Table-specific notes:

- `tours` / `tour_timeslots`: all roles can read; only `owner` can write. (Timeslots are
  shared, so managers never edit schedules.)
- `customers`: owner + manager + check-in of the business can insert and read; update is
  owner + manager; delete is owner only.
- `bookings`: insert/delete is owner + manager (by business); check-in can read + update
  (check guests in) for assigned tours only.
- `business_tours` / `tour_pax_tiers`: owner full; manager read + write for their
  business; check-in read only.

When something returns no rows or a write silently fails, it is almost always RLS.
Verify the caller's role/business with `/dashboard/debug` and compare against the policy.

## Conventions

- UUID primary keys (`gen_random_uuid()`); `bigint identity` only for `audit_log`.
- Timestamps are `timestamptz`; `created_at` / `updated_at` on every table.
- Money is integer `*_cents`; never floats.
- Business operating timezone is `America/New_York` (see `businesses.timezone`).
