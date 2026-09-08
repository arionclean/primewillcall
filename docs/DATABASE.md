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
can_check_in, can_void_bookings, can_add_to_peek, can_view_attachments,
can_redeem_groupon, can_view_details, can_use_caja, can_manage_sales, can_manage_team,
can_view_payments, pin_required, created_at, updated_at`
Role enum (`staff_role`): `owner`, `business_manager`, `check_in`. `owner` has no
`business_id`. A trigger links a new `auth.users` row to its `staff` row by email.

The `can_*` booleans are per-staff booking permissions, editable by the owner
on `/admin/staff/[id]` ("Permissions"). Owners ignore them (always allowed); they
gate managers and check-in staff. They come in two kinds.

**Write permissions** (`can_create_bookings`, `can_edit_bookings`, `can_check_in`,
`can_void_bookings`, `can_add_to_peek`, `can_redeem_groupon`) are enforced by the
bookings RLS policies plus the `bookings_enforce_update_capabilities` trigger. The
update policy admits a row to anyone holding any of edit / check-in / peek / redeem /
void; the trigger then checks each stamp against its own switch (`checked_in_at` needs
`can_check_in`, `peek` needs `can_add_to_peek`, `groupon_redeemed_at` needs
`can_redeem_groupon`, the void stamp needs `can_void_bookings`) and, without
`can_edit_bookings`, refuses any other change. `can_void_bookings` was
`can_delete_bookings` until migration `20260907240000_void_not_delete`; see "Void, not
delete" under bookings.
RLS alone cannot express column-level rules, which is why the trigger exists.
Service-role writers have no `current_staff()` row and pass through.

**View switches** (`can_view_details`, `can_view_attachments`) decide what the
bookings page fetches and shows. Off, `can_view_details` leaves the desk with the ID,
name, phone, guest count and check-in status (no note, no email, no edit form);
`can_view_attachments` off hides the voucher photos. `can_redeem_groupon` also gates
seeing the Redemption Codes. These are screen-level: RLS is row-level and cannot hide
a column, so `bookingSelect()` in `bookings/list.tsx` leaves the withheld columns out
of both the server read and the browser refetch, and the Realtime patch drops them
from change payloads. A change payload on the wire still carries every column the
row policy allows; treat the view switches as privacy on the device, not a boundary.

**Manager switches** (all default on, so a manager keeps what they had until the owner
turns one off; owners always have them; check-in accounts never do):
`can_manage_sales` gates the `payments` function's money actions (refund a card or cash
sale, void a cash sale, move a sale between kiosks; the passcode is still asked) and the
matching buttons on `/admin/payments`; `can_manage_team` gates the People tab's writes
(add employee, change PIN, pause, remove), in the server actions and in the
`kiosk_employees` insert / update / delete policies, which read the caller's own staff
row; `can_view_payments` hides the Payments link and page (screen-level, the RPCs stay
RLS-scoped by business).

**Caja switch** (`can_use_caja`, default on) decides whether a check-in login gets
`/caja` (the desk's own cash + card for the day and the end-of-night count). The
sidebar hides the link and the page redirects without it, and RLS backs it:
`current_kiosk_slug()` returns NULL for an account without the switch, so the
per-kiosk `cash_sales` / `stripe_transactions` read policies match nothing. Owners
and managers are unaffected (they use `/admin/payments`).

Defaults: create/edit/check-in/peek/attachments/details/caja on, delete and redeem off
(new managers get delete on from the New team member form). Redeem was owner-only
before the switch existed, so the default preserves that.
`bookings.peek` marks a booking as manually entered into Peek (the boat's
reservation system); it is the same field the Xano sync carries, so both stacks
agree during the migration.

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
`/availability` page; read by the public `gp-*` edge functions so closed times
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
due_cents, created_at, updated_at`
`status` is the payment lifecycle the app exposes: `confirmed` (normal, shown with
no tag), `pending` (shown as "Waiting for payment"), and `cancelled`. Bookings created
from `/schedule` start as `confirmed`. The enum (`booking_status`) also contains the
legacy values `checked_in` and `completed`; the app no longer writes them. Check-in is
tracked independently of status via `checked_in_at` (set/cleared by the check-in
toggle and the check-in API), so a guest can be checked in regardless of payment status.

#### Void, not delete

Nobody deletes a booking (there is no DELETE policy, owner included; migration
`20260907240000_void_not_delete`). A booking that should not count is **voided**:
`void_booking(p_booking_id, p_reason)` sets `status = 'cancelled'` and the void stamp,
`voided_at`, `voided_by_staff_id`, `void_reason` (required, as typed) and
`voided_from_status` (what it was, for a restore). The row stays, and the activity log
records the update with its diff, so the owner sees who voided what and why. Building
on `cancelled` is deliberate: every manifest, report, message rule and the tablet
already leave cancelled bookings out, so a voided booking stops counting with no other
query touched. The screens tell the two apart by the stamp ("Voided" versus
"Cancelled"), and `void_reason` is withheld like `notes` without `can_view_details`.

Guards, in layers: the Void button needs `can_void_bookings` (owners always); the
function re-checks it; RLS scopes which rows it reaches (SECURITY INVOKER); the
`bookings_enforce_update_capabilities` trigger refuses the stamp without the switch and,
for an account without edit, lets a void change nothing but the stamp and the status.
While `voided_at` is set, the `bookings_keep_voided_cancelled` trigger forces `status`
back to `cancelled` on any update (the edit form's status field, a status resend from
Xano), and `bookings_cancel_messages_on_void` cancels every pending `scheduled_messages`
row for the booking. `restore_booking(p_booking_id)` is owner only: status back to
`voided_from_status`, stamp cleared. Both functions raise short tokens (`not_allowed`,
`reason_required`, `already_voided`, `not_voided`, `not_found`) that the bookings list
maps to plain sentences.

Cash sales carry the same stamp (`cash_sales.voided_at / voided_by / void_reason`),
written by the `payments` function's `void_cash` action; see "Payments (Stripe)".

A void is also how **Xano deletions** are reconciled. Xano's booking trigger sends
nothing on a delete, so a booking removed in Bubble lives on here and keeps counting.
`scripts/reconcile_xano_ghosts.py` diffs every Xano-sourced row against Xano's public
booking listing (read-only) and, with `--live`, voids the ones Xano no longer has
(`voided_by_staff_id` null, reason "Deleted in the old system (reconciliation <date>)").
First run 2026-09-07: 278 bookings, all past tours (a first pass also caught 13 bookings
made in the minutes between the two reads; they were restored at once, and the script now
re-reads Xano's newest pages every run and never judges a row created after the Xano read).

`due_cents` (default 0) is what the guest still owes at the desk, separate from the
price in `total_cents`. The desk used to type it into the guest's name ("Alfred B Owes
$36"); now `/schedule` takes it as its own field (`create_booking(p_due_cents)`), the
bookings list shows an "Owes $36" tag to every role, and the edit form clears it once
collected. The kiosk collecting it against the booking (instead of creating a second
sale) is the pending half.

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

The sync treats a booking it already holds differently from a new one: for an
existing row it applies only what Xano owns (status, time, pax, check-in, reference,
channel, token, Peek, photos), never the business's copy of the tour (unless the
master tour changed), the guest row, the price or the breakdown. See "The echo of a
Xano-born booking" in `docs/xano-mirror.md`.

`xano_internal_id` and `xano_booking_id` say where the booking lives in Xano: its
`internal_id` (what `booking/v12` adds or edits by, and what Xano's echo is matched
on) and its numeric row id (what the iPad's PATCH addresses). The sync stamps both
from every echo; the mirrors stamp the internal id BEFORE calling Xano. A booking
born here therefore keeps `legacy_id` null (every "is this ours" rule reads that)
and is still recognised when Xano echoes it back. See "Xano mirror" below.

### Xano mirror (bookings -> Xano)

The reverse of `xano-booking-sync`: every booking change made in this app is copied
into Xano through an outbox (`docs/xano-mirror.md`). Migration `20260908100000_xano_mirror.sql`.

- `xano_mirror_settings` (single row): `enabled` (default false). Owner select/update.
- `xano_mirror_queue`: `booking_id`, `op` (`create`/`update`), `fields` (the mirrored
  fields that changed, merged across edits), `status` (`pending`/`sending`/`sent`/`failed`),
  `attempts`, `next_attempt_at`, `last_error`. Partial unique index: one pending row
  per booking. RLS: owner select only; nothing writes through the API. No screen
  reads it either (the owner's choice); it is read by SQL.
- `enqueue_xano_mirror()` (AFTER INSERT OR UPDATE on bookings, SECURITY DEFINER):
  skips writes whose `x-sync-origin` request header is `xano` (the sync, the ghost
  script) or `mirror` (the kiosk sale flow, the worker); on INSERT queues a `create`
  only for a booking born here that no other mirror owns (`legacy_id` null, not
  Groupon, not awaiting payment); on UPDATE queues an `update` when time, product,
  status, pax, check-in or note changed and the booking has a Xano row to address.
  `xano_mirror_origin()` reads the header; `text_array_union()` merges the fields.
- `claim_xano_mirror_rows(batch)` (SECURITY DEFINER, service_role only): the worker's
  `FOR UPDATE SKIP LOCKED` claim; a row stuck in `sending` for ten minutes goes back
  to pending first.
- pg_cron job `xano-mirror-dispatch`, every minute, same shape as the messaging
  dispatcher (vault `dispatch_cron_secret`).

### create_booking() (the one way a booking is created)

`create_booking(p_business_tour_id, p_date, p_slot_start, p_customer_name, ...)` inserts
the customer and the booking **in one transaction** and returns
`(booking_id, public_token, total_cents, starts_at, ends_at)`. Migration
`20260816120000_create_booking_rpc.sql`.

Both callers go through it:

| Caller | Mode | Guards |
|---|---|---|
| `/schedule` staff form (`schedule/actions.ts`) | `p_pricing => 'tiers'` | closures and inactive slots allowed (staff override) |
| public `gp-book` edge function | `p_pricing => 'groupon'` | `p_respect_closures`, `p_active_slots_only` both true |

What the database decides, not the caller:

- **The slot duration.** Read from `tour_timeslots`, so `ends_at` is always the tour's
  real duration. `/schedule` used to post `slot_duration` from the form and trust it.
- **The prices.** `tiers` mode reads `tour_pax_tiers`; `groupon` mode reads
  `business_tours.groupon_fee_cents`. The caller sends quantities only. The single
  exception is `p_total_override_cents`, the deliberate desk-side adjustment, which moves
  the charged total and leaves the breakdown at list prices.
- **The UTC timestamps.** `(date + time) AT TIME ZONE 'America/New_York'` resolves the
  real offset for that date, DST included. This replaced a hand-rolled offset parse that
  had been copied into three TypeScript files.

`SECURITY INVOKER`, so **RLS still decides**: the staff form runs as the signed-in user
and is governed by the `customers` / `bookings` policies; `gp-book` runs as the service
role and bypasses them, exactly as before. A policy denial arrives as SQLSTATE `42501`.
Failures raise a short stable token the callers map to their own wording:
`tour_not_available`, `bad_slot`, `slot_closed`, `no_prices`, `no_guests`,
`groupon_not_available`.

The `on_native_booking_created` trigger still fires from the insert inside the function
(`legacy_id` is NULL at insert time), so the messaging automations are unaffected.

### staff_tours
`staff_id, tour_id, created_at` — which tours a `check_in` staffer is assigned to.

### audit_log
`id bigint pk, occurred_at, actor_staff_id?, actor_kiosk_id?, business_id?, employee_id?,
employee_name?, entity, entity_id? (text), action, changed text[], payload jsonb, source`
— what staff did in the web app, written by the `log_staff_change` trigger on every
table staff edit (only for a real staff session; system writes are skipped) and by the
`payments` function for its own writes. `employee_id` is the person behind a shared
login (`staff.pin_required`), read from the `x-employee-id` request header. Read with
`kiosk_events` through `activity_feed()` on `/admin/staff` (Team, People tab). Owner reads all; a
manager their business's rows and their own; check-in their own. See
docs/kiosk-employees.md "The web app".

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

**A $0 fee skips Stripe entirely.** Stripe will not take a payment under $0.50, so a
product whose `groupon_fee_cents` is `0` (Jet Ski, today) used to sit `pending` forever:
never paid, so never texted and never mirrored to Xano. There is nothing to charge, so
`gp-book` creates the booking `confirmed` and mirrors it to Xano itself, since the webhook
that normally does the mirroring never fires for it.

**An abandoned checkout is not a booking.** The booking has to exist before payment (the
Checkout Session carries its id in metadata), so a guest who opens the payment page and
walks away leaves an unpaid `pending` row that Xano never hears about. `gp-book` therefore
sets `bookings.awaiting_payment` when it hands the guest a Checkout page, and the
`bookings_select` policy hides any row that is `awaiting_payment AND paid_at IS NULL AND
status = 'pending'`. The webhook clears the flag in the same write that confirms the
booking. All three conditions must hold for a row to be hidden, so a missed webhook leaves
the booking visible rather than lost. Bookings never handed a payment page are unaffected:
the $0 path, the manual-collection fallback, and `pending` bookings synced from Xano all
stay visible. Service-role callers bypass RLS, so the guest's own `/booking/<token>` page
still shows it and they can come back and pay.

### Schema
- `bookings.awaiting_payment` (bool, default false) — set while a /gp guest holds an
  unpaid Stripe Checkout page. Hidden from staff by `bookings_select`; cleared by
  `stripe-webhook` on payment. Nothing else in the app writes it.
- `business_tours.groupon_fee_cents` (int, nullable) — the owner-managed per-passenger
  convenience fee for that product. `NULL` = the product does not accept Groupon;
  `0` = offered free. Owners edit this on the owner-only `/admin/groupon` page.
- `gp-vouchers` storage bucket (public read) — the uploaded voucher photos. Writes are
  done server-side with the service role, so there is no anon insert policy.
- `businesses.groupon_merchant_names` (`text[]`, default `{}`) — extra Groupon storefront
  names this business sells under, beyond `businesses.name`. Groupon lists one operator
  under several storefronts, and only some of them are real businesses: Miami Skyline
  Cruises also sells as "Miami Star Island Cruises" and "Miami Tour Bus". Drives the
  merchant gate below. No admin UI yet; set it in SQL.
- `groupon_candidates()` — SECURITY DEFINER RPC returning the Groupon-enabled
  `business_tours` (fee not null, active) joined to business + tour, with each tour's
  `tour_name_aliases` as a `text[]` and the business's storefront names as
  `merchant_names`. The validator feeds this small candidate set to the vision model; the
  fee always comes from this row, never from the model.

### Request flow (all server-side, service role; no anon DB access)
- `gp-validate` (edge function): uploads the photo to `gp-vouchers`, then hands the public URL
  to the `gp-voucher-vision` edge function and returns
  `{ valid, businessTourId, productName, feeCents, passengers, voucherCode, imageUrl }`.
  The edge function ports the Xano vision chain (~1.5s avg there): Google Cloud Vision
  TEXT_DETECTION OCR (`GOOGLE_API_KEY`), Groq llama-4-scout vision as OCR fallback, the
  product match below (zero AI in the common case), and Groq `openai/gpt-oss-120b` for
  passenger + redemption-code extraction (the "1 of 1 = one voucher, not one passenger"
  trap is handled in the prompt; OpenAI is the extraction fallback). AI keys live as
  **Supabase function secrets**, not app env. Deployed with verify_jwt on; the route calls
  it with the service role key. If the function is unreachable the route degrades to a
  graceful "couldn't read the voucher".
  **The voucher code is read from the OCR text first** (`_shared/gp-voucher-code.ts`: the
  labelled Redemption Code, a printed voucher's bare code line, then the Groupon `VS-`
  number), and the model's code only counts when the text had none and it is shaped like a
  code. **A voucher with no readable code is refused** (`error: "missing_code"`): staff
  redeem by the Redemption Code, and the screenshot guests send most is the app's voucher
  card, where the code sits behind a "View Voucher" tap. Graded on 156 stored uploads
  (120 most recent plus 36 shadow rows), 13 of 108 accepted uploads had no code anywhere
  and every one was that card, the "My Groupons" list, the purchase confirmation or an
  unrelated page; zero vouchers with a visible code were refused. Real OCR text for each
  layout is replayed in `_shared/gp-voucher-code.test.ts`.

  **Product match** runs three deterministic tiers over `groupon_candidates()`, most
  precise first, before the model is asked to decide:
  1. **title** — a product name or `tour_name_aliases` entry appears verbatim in the OCR
     text (compared with punctuation and case stripped). Longest hit wins, since a longer
     title is a more specific one; an equal-length tie goes to the title with more words,
     so the answer never depends on the order the catalog rows came back in. A title must
     be at least **two words**: a one-word product name is a category, not a title, and
     it appears inside other products' titles. "Transportation" (the fee-bucket product)
     sat verbatim in "Everglades Tour with Transportation from Miami" and tied
     "Everglades Tour" on length, so Everglades guests were booked onto Transportation and
     shown its 8am-8pm departures. The matcher lives in
     `supabase/functions/_shared/gp-match.ts`; `gp-match.test.ts` replays the real OCR
     text of the vouchers that broke it.
  2. **fuzzy** — the title's words appear together inside a short window of the OCR text,
     so one dropped, inserted, or misread word no longer loses the match. This is the tier
     Xano bought with its scoring lambda and the one the first port was missing. Two
     guards keep it honest: a title whose *distinguishing* word (boat, combo, sunset,
     island, …) is absent from the voucher is rejected outright, and a window carrying a
     *splitter* the title does not claim is skipped, so a "City Tour and Boat Combo"
     voucher cannot land on the plain city tour. If two products score within 0.1 of each
     other the match is treated as ambiguous and handed to the model.
  3. **merchant** — the storefront name alone, and only when that business has exactly one
     Groupon-enabled product. The storefront says who sold the voucher, not what it is
     for: "Miami Skyline Cruises" is printed on that business's city-tour vouchers too, so
     it must never outrank a title match, and when the business sells several products the
     tier stays silent rather than coin-flip the product and its fee.

  Anything still unmatched falls to the model, which picks from the same candidate list,
  **gated on the merchant**: the model's answer is only accepted when the voucher text
  names one of the `merchant_names`. Asked to choose from a catalog the model returns the
  closest entry even when nothing fits, and a real voucher for "Skyline & Coast Cruise"
  sold by *N.Y.C Skyline Tours & Cruises* came back as Miami Skyline Cruises, which would
  have booked a Miami tour and charged the fee. The deterministic tiers are deliberately
  exempt from the gate: they already require one of our own product titles in the voucher,
  and gating them would drop real vouchers whose photo is too poor to read the storefront
  line. The fee always comes from the matched row, never from the model.
- `gp-slots` (edge function; body `{ business_tour_id, date }`): active `tour_timeslots` for the matched
  product's master tour, past times hidden for today (NY), minus any
  `tour_slot_closures` for that date. Replaces Xano `manage_slots`.
- `gp-book` (edge function): re-validates the product + fee (and rejects a time closed for
  that date), creates the customer
  (`legacy_source = 'groupon'`) and a `pending` booking (`source_channel = 'groupon'`,
  `legacy_reference = <codes, comma-joined>`, `groupon_voucher_codes = <one per voucher>`,
  `total_cents = fee × passengers`, the fee as a
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

**Account shape.** New accounts are created with controller properties
(`connectControllerParams()` in `src/lib/stripe/server.ts`), never `type: "express"`. The
shorthand sets `controller.fees.payer = application_express`, which bills Stripe's Connect
fees ($2 per monthly active account + 0.25% of payout volume) to PRIME. Spelling the
controller out (`stripe_dashboard.type: express`, `fees.payer: account`,
`losses.payments: stripe`) gives the business the identical Express dashboard and Stripe-run
onboarding while Stripe bills the business and charges the platform nothing. The Xano-era
fleet is still on the old shape; each one migrates via the owner-only flow on
`/admin/businesses/[id]` using the three columns below. Full runbook, including the kiosk
Terminal step that is deliberately not built yet, in
[`docs/stripe-fee-free-accounts.md`](stripe-fee-free-accounts.md).

- `businesses.stripe_account_id_pending` (text, unique): a new fee-free account while it
  onboards. Takes no charges; the live account keeps every charge until the switch.
- `businesses.stripe_account_id_legacy` (text[]): retired accounts, oldest first.
  Reference only, so the old account stays findable while its balance pays out.
- `businesses.stripe_fees_payer` (text): `controller.fees.payer` of the live account,
  synced from Stripe. `account` = Prime pays no Connect fees. `application*` = Prime is
  billed. NULL until the first status refresh.

Switching accounts never strands a refund: the refund action routes by
`stripe_transactions.connected_account_id` (the account the charge settled on), not by the
business's current account.

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
  `booking_id`/`booking_ref`, `amount_cents`, `type`, `product`, `status`, `kiosk_slug`,
  the refund columns, and the void stamp `voided_at` / `voided_by` / `void_reason`). A
  cash sale is never deleted: the `payments` function's `void_cash` action (owner or the
  business's manager, refund passcode, reason required) stamps it, `payments_scope`
  lists it with `effective_status = 'voided'` (the search word "voided" finds it) and
  `payments_summary` and Caja leave it out of the cash total and count. A sale with a
  refund on it was real and cannot be voided, and a voided sale cannot be refunded
  (`cash_sales_void_xor_refund`). Card sales are not voided: a captured charge is
  refunded instead.
  Card kiosk sales need no table: a Terminal PaymentIntent is a direct charge, so the webhook
  records it into `stripe_transactions` with `source='kiosk'`.
- `kiosks` (Kiosk POS columns) — `business_id`, `slug` (the tablet's login tag; unique),
  `stripe_account_id` (optional per-kiosk Connect override), `terminal_location_id`,
  `simulated`. Maps a tablet to the connected account its sales settle on.

- `kiosk_sales` — kiosk **card flow v2** (docs/kiosk-card-flow-v2.md): one row per card
  sale, written by `kiosk-sale-start` BEFORE the reader is asked for the card (`ref` = the KS
  code, `amount_cents`, `customer_name`, `payment_intent_id`, `stripe_account_id`, the hidden
  pending `booking_id`, the `xano_payload` the server mirrors to Xano once paid). `status`
  pending -> paid (by `completed_by` tablet, sweep or reuse) or abandoned; `tablet_acked_at`
  marks that a tablet showed the paid outcome, which is what stops a captured payment from
  ever being attached twice. Service role writes only; staff read by business.
- `kiosk_events` — append-only stream from the tablets (`kiosk-log`) and the kiosk sale
  functions: reader connected/dropped/battery, sale started, card result with the SDK error,
  sale completed, Xano mirror results. `kiosk_slug`, `app_build`, `device_id`, and `ref` (the
  KS code) on every row. In the realtime publication. Same read policy as `cash_sales`.
- `kiosk_employees` — the people who use the tablets (docs/kiosk-employees.md), one pool
  shared by every business (no business column, by the owner's choice): `name`,
  `staff_id?` (the same person's website login, unique; not used by the screens yet),
  `pin_hash` + `pin_salt` (`sha256(salt:pin)`, unique across all active employees via the
  `kiosk_pin_in_use` definer function), `is_active`, `last_seen_at` / `last_seen_kiosk`.
  Any active staff reads; owner and business managers write. Referenced by
  `kiosk_events.employee_id` (+ `employee_name`), `kiosk_sales.employee_id`,
  `cash_sales.employee_id` and `bookings.kiosk_employee_id`, all `on delete set null`.
- `kiosks.pin_required` (default false): the PIN switch. `pin_idle_lock_seconds` (120) is
  unused: the app no longer auto-locks, by the owner's choice.
- `kiosks.card_flow` (`v1` default, `v2`), `reader_low_battery_pct` (25),
  `reader_block_battery_pct` (10) — the per-kiosk rollout switch and battery thresholds the
  tablet reads through `kiosk-config`. An old build ignores them.

### RPC
- `stripe_payments_summary(p_start, p_end)` — gross / net / stripe_fees / application_fees /
  refunded / count for a date range, `SUM`'d in the DB. `SECURITY INVOKER`, so
  `stripe_transactions` RLS still scopes the totals by business. Superseded for
  `/admin/payments` by `payments_summary` (card + cash), kept until the deploy that stops
  calling it.
- `payments_summary(p_start, p_end, p_business, p_source)` — the same totals plus kiosk cash
  (`cash_sales` where `type='cash'` only; its `card` rows mirror Stripe charges and would
  double count). Backs the `/admin/payments` summary cards (never sum the ledger in JS: the
  1000-row read cap would truncate).
- `payments_feed(p_start, p_end, p_business, p_source, p_q, p_limit, p_offset)` — one page of
  the merged card + cash feed, newest first, with the whole-range row count in `total_count`
  (a `count(*) over ()` computed before the LIMIT). The union, sort, paging and count all
  happen in the DB: merging two tables in JS cannot be paged, because an offset applied to
  each source separately does not offset the merged list. `SECURITY INVOKER`. Backs the
  `/admin/payments` table and its pagination (50 rows per page).

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
- **Webhook** (`stripe-webhook` Supabase edge function, `supabase/functions/stripe-webhook/`):
  one endpoint for both platform and Connect deliveries (two dashboard endpoints, two signing
  secrets: `STRIPE_WEBHOOK_SECRET` + `STRIPE_WEBHOOK_SECRET_CONNECTED`, set as Supabase
  function secrets). Deployed with JWT off; the Stripe signature is the auth. Uses the
  official `constructEventAsync` verifier (Deno has no Node crypto).
  Handles `checkout.session.completed` / `payment_intent.succeeded`
  (flip booking to `confirmed`, set `paid_at` + `stripe_payment_intent_id`), `charge.*`
  (upsert the ledger), `charge.dispute.*`, and `account.updated`.
  On `checkout.session.completed` it also **emails the Stripe receipt** by setting
  `receipt_email` on the charge (the address Checkout collected) and copies that address
  onto the booking's customer when the row has none. Stripe does not send a receipt on its
  own for a direct charge unless the connected account has "Successful payments" emails
  on, and these accounts have no Dashboard page to switch it on, so without this step the
  /gp success page's "a receipt was emailed" was untrue for every payment.
- **Booking link**: every charge carries `metadata.booking_id` + `metadata.source` (set on
  both the session and `payment_intent_data` so the CHARGE carries it). The webhook resolves
  `booking_id` and `business_id` (via `connected_account_id`) into the ledger row. `bookings`
  gains `paid_at`; the existing `stripe_payment_intent_id` is set on payment.
- **Payments dashboard** (`/admin/payments`, owner + `business_manager`; `check_in` is
  redirected out since it has no ledger read): a merged card + cash table (date range,
  source and owner business filters, search, paged 50 at a time via `payments_feed`) plus
  summary cards from `payments_summary`. The range defaults to the current month to date.
- **Move a sale to another kiosk** (`moveSaleSource` in `admin/payments/actions.ts`): a
  tablet sometimes rings up a sale that belongs to another kiosk, so owner and the
  business's own manager can re-tag it. No money moves, so there is no passcode. It writes
  the new kiosk into the SAME column the totals already read (`stripe_transactions.source`,
  `cash_sales.kiosk_slug`), so every reader stays correct with no change: the feed, the
  totals, the Source filter, and that kiosk's `/caja` (whose RLS is `source =
  current_kiosk_slug()`). The pre-move value is kept in `source_original` /
  `kiosk_slug_original`, with `source_moved_at` + `source_moved_by` for the trail, and the
  row shows "moved from Kiosk N".
  **The trigger is the point**: the webhook re-upserts a charge on every later Stripe event
  for it and recomputes `source` from the tablet's metadata, so a plain edit would silently
  revert. `pin_moved_transaction_source` / `pin_moved_cash_source` (BEFORE UPDATE) pin the
  kiosk once a sale has been moved, refusing every writer including the webhook. Only a
  write that also changes `source_moved_at` (the move action itself) may set it.
- **Refund** (`admin/payments/actions.ts`): owner or the charge's `business_manager`; creates
  the refund on the connected account (direct charge), records `stripe_refunds` with the
  acting staff, and optimistically updates the transaction (the `charge.refunded` webhook
  reconciles). `source='online'|'groupon'|'kiosk'` charges are all refundable here.
- **Customer payment link** (`POST /api/bookings/[id]/payment-link`): staff mint a Checkout
  link for a booking (RLS authorizes the read, direct charge on the business's account with
  the platform fee) and send it to the customer; surfaced by the "Payment link" button in the
  booking edit modal.
- **Kiosk POS (Stripe Terminal)**: the `kiosk-connection-token` (Terminal connection
  token) + `kiosk-payment-intent` (`card_present` direct charge with the platform
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
Each voucher is still redeemed on Groupon's own platform, by its Redemption Code
(`groupon_voucher_codes`, below; the guest's screenshots are in
`groupon_voucher_urls`). Once done, it is recorded here via
`bookings.groupon_redeemed_at` (nullable timestamp, mirrors `checked_in_at`): the
bookings list shows a "Redeem" / "Redeemed" toggle on `source_channel = 'groupon'`
rows to the owner and to staff with `can_redeem_groupon`. Independent of check-in
and payment status. The `bookings_enforce_update_capabilities` trigger refuses a
`groupon_redeemed_at` change from any non-owner without the permission.

### Redemption codes on the row
`bookings.groupon_voucher_codes` (`text[]`, one Redemption Code per voucher, in upload
order) is written by `create_booking()` from `gp-book`, and was backfilled from
`legacy_reference` for the /gp bookings made before the column existed (only entries
shaped like a code: the 6-10 digit Redemption Code or the older `VS-XXXX-...` voucher
number). The bookings list shows the codes to whoever may redeem (the owner, plus staff
with `can_redeem_groupon`), as a chip under the guest's name in both the desktop and phone layouts: one code
copies on click; several show the first plus a count and open a small list with a copy
button per code (Groupon redeems one code at a time) and a check on each code already
copied, plus "Copy all". Privacy mode masks them. The codes deliberately do not rely on
`legacy_reference`: `xano-booking-sync` overwrites that field with Xano's
`booking_reference` (the `GP-...` mirror reference) on every round trip, and it never
maps `groupon_voucher_codes`, so the column survives the mirror. The booking **note** is
a plain "Groupon redemption": every role reads notes, so it carries neither the code nor
the voucher URL (migration `groupon_voucher_codes_from_notes` scrubbed the old ones and
recovered the codes of the mirrored rows from them). The Xano mirror composes the fuller
"code X · voucher URL" note Bubble staff read from the two columns.

## Analytics source labels

`/analytics` groups bookings by `bookings.source_channel`, which holds whatever the
booking system sent: Bokun stamps its own channel names ("Default Channel", "Miami
Skyline", "www.miamicelebrityboattours.com - Website"), the Xano mirror renames /gp
bookings from `groupon` to `groupon-surcharge`, staff entries arrive as "Manual". The same
website showed under four names and "Default Channel" (the Bayside site's Bokun widget,
which is where the jet ski sells) meant nothing to staff.

### booking_source_labels

`channel (pk, raw source_channel, matched case-insensitively), label, updated_at`. The
`analytics_source_tour` RPC left-joins it and shows `coalesce(label, raw, 'Direct')`. A
channel with no row shows as is. The raw value on the booking is never rewritten: RLS
(unpaid /gp rows), the Redeem chip and the Xano mirror all key on `source_channel`. Read by
every active staffer (the RPC is SECURITY INVOKER), edited by the owner only. There is no
screen for it yet; edit rows in SQL. One format: an OTA is its brand name, a website
widget is "<Site> - Website", the kiosk is "Kiosk - Card" / "Kiosk - Cash". Seeded
2026-09-07:

| Raw channel | Label |
| --- | --- |
| `groupon`, `groupon-surcharge` | Groupon |
| `kiosk-sale-card`, `kiosk-sale-tap` | Kiosk - Card |
| `kiosk-sale-cash` | Kiosk - Cash |
| `Viator.com`, `Viator`, `Viator.com<http://viator.com/>` | Viator |
| `civitatis.com`, `Civitatis`, `civitatis.com<http://civitatis.com/>` | Civitatis |
| `www.tiqets.com/en/`, `www.tiqets.com` | Tiqets |
| `www.klook.com` | Klook |
| `headout.com` | Headout |
| `www.tripshock.com` | TripShock |
| `Miami Skyline`, `Miami Skyline Cruises`, `Miami Skyline Cruisees` | Miami Skyline Cruises - Website |
| `Default Channel`, `Miami Star Island`, `Miami Star Island Cruises`, `Miami Boat Tours - Website`, `Miami Boat Tours/ Bayside Kiosk - Website`, `Miami Bayside Boat Tour`, `www.miamicelebrityboattours.com - Website` | Miami Bayside Boat Tour - Website |
| `Miami Sunset Boat`, `Miami Sunset Boat Cruises`, `Miami Sunset Boat Cruises - Website` | Miami Sunset Boat - Website |
| `Key West Sightseeing Tours`, `Key West Sightseeing` | Key West Sightseeing Tours - Website |
| `Prime-combo-sale`, `Prime combo-sale`, `Prime-combo sale` | Prime Combo Sale |
| `www.ineedtours.com` | I Need Tours |
| `miami architecture cruise`, `Miami Architecture cruises`, `architecture cruises` | Miami Architecture Cruise |

Bokun account per website, from the booking reference prefix: `4TH-` Skyline, `BOAT-`
Bayside and jet ski, `MIA-` Star Island, `SUN-` Sunset Boat.

### booking_source_options (what the desk can pick)

`channel (pk), sort_order, is_active, updated_at`. The `/schedule` form requires a
source and only accepts an active row; the value is stored verbatim as
`bookings.source_channel`, so a desk booking never lands blank ("Direct") again. Seeded
with the desk's real cases: Manual, Phone reservation, Miami Tour Bus, Big Dave, the
OTAs phoned in (Viator, GetYourGuide, Groupon, Civitatis) and the five website labels.
Owner-edited in SQL (no screen yet); read by every active staffer.

### analytics_bookings (drill-down)

`analytics_bookings(p_start, p_end, p_source, p_tour, p_business_id)` returns the
bookings behind one source x tour cell (id, starts_at, customer, pax, status, created_at,
source, tour, business), capped at 300 and ordered by start time. It applies the same
range, non-cancelled filter and label mapping as `analytics_source_tour`, so the list
always matches the number that was clicked. SECURITY INVOKER: `bookings_select` scopes the
rows and the customers policy decides whether the name is readable (else "Guest"). Called
from the browser when a right-list item is clicked on `/analytics`; each row links to
`/bookings?date=<day>&booking=<id>`, the deep link the bookings page already honours.

## Access control (RLS)

RLS is enabled on all app tables. Every policy is expressed through the
`current_staff()` SECURITY DEFINER function, which returns the caller's
`(staff_id, role, business_id)`. This avoids recursive policy lookups on `staff`.

**Messages are scoped by the customer's business.** `sms_messages` and
`whatsapp_messages` carry `business_id`, and that is what a manager's SELECT policy
matches. The column is filled by the `link_message_customer` BEFORE INSERT trigger:
`message_link_customer()` resolves the counterpart phone through
`customers.phone_last10`, preferring the customer whose latest booking precedes the
message when a phone belongs to customers in several businesses. It runs for every
writer, including the Twilio history sync that copies in the messages Xano sends,
which is what used to leave a manager seeing only the guest's replies. A row whose
phone matches no customer stays NULL and is visible to the owner only.

Two costs of RLS to design around (both bit the Messages list, see
`messaging_conversations`):

- **A policy runs once per row scanned, not per row returned.** `current_staff()` is
  SECURITY DEFINER, so it cannot be inlined, and a query that touches 93k `customers`
  rows calls it 93k times even when it keeps 50. Settle the page first, then look the
  rows on it up by key. And write the policy so `current_staff()` sits in an
  uncorrelated scalar subquery, `(select role from current_staff()) = 'owner' or
  business_id = (select business_id from current_staff())`: the planner evaluates that
  once per statement (an InitPlan). The older `EXISTS (select 1 from current_staff() cs
  where ... cs.business_id = t.business_id)` form mentions the row, so it runs per row.
  The messaging tables use the InitPlan form; the rest still use EXISTS and are worth
  converting when one of them shows up slow.
- **An index is only usable under RLS if the WHERE clause is leakproof.** Postgres
  refuses to evaluate a clause containing a non-LEAKPROOF function before the policy,
  because such a function could expose hidden rows through its error messages, and an
  index condition is exactly that. `regexp_replace` is not leakproof; `=` on a plain
  column is. So an expression index on `regexp_replace(phone, ...)` is used by the
  table owner and silently ignored for `authenticated`: the same query took 0.5 s in
  the SQL editor and timed out at 8 s for a staff member. Materialise the key instead
  (`customers.phone_last10` is a stored generated column) and compare it with `=`.

General shape:

- **owner**: full access to everything.
- **business_manager**: read + write rows belonging to their `business_id`
  (`bookings`, `customers`, `business_tours`, `tour_pax_tiers` via the parent business).
- **check_in**: read `business_tours` / `tour_pax_tiers` for their business AND every
  business's copy of a tour they are assigned to (plus those businesses' rows in
  `businesses` and their `customers`), since 2026-09-08 (`checkin_sees_all_copies`,
  `checkin_reads_visible_guests`): one desk checks in
  Key West's and Miami Skyline's guests alike, and the bookings screen needs the
  other copy's name, tiers and filter entry. Read only; writes stay on their own
  business. Read, insert and update `bookings` only for tours they are assigned to via `staff_tours`
  (each write also gated by the `staff.can_*` capability columns). Can insert
  `customers` for their business. Void (never delete) only when `can_void_bookings` is on.

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
  needing `can_create_bookings`. Update: same row scopes, needing any of
  `can_edit_bookings` / `can_check_in` / `can_add_to_peek` / `can_redeem_groupon` /
  `can_void_bookings` (the trigger limits an account without edit to its stamps).
  Delete: nobody, owner included (no policy). Void through `void_booking()` instead.
- `bookings_checkin_manifest(p_start, p_end)` — SECURITY INVOKER RPC: per-`starts_at`
  remaining-to-check-in pax + total pax for a day window, cancelled excluded, aggregated
  in the DB. RLS scopes it (check-in staff count only their assigned tours). Backs the
  sidebar Manifest that check-in accounts see (`components/app/sidebar-manifest.tsx`),
  which live-refreshes off a bookings Realtime subscription.
- `business_tours` / `tour_pax_tiers`: owner full; manager read + write for their
  business; check-in read only.

When something returns no rows or a write silently fails, it is almost always RLS.
Verify the caller's role/business by querying `current_staff()` and compare against the
policy.

### The staff row in the access token

`getCurrentStaff()` (`lib/auth.ts`) does not query `staff`. The
`custom_access_token_hook` function (migration `staff_claims_hook`) copies the row into
the JWT as an `app_staff` claim when Auth issues a token, so the layout answers "who is
this and what may they do?" locally on every navigation instead of paying a 140 to
200ms round trip. The hook runs as `supabase_auth_admin`, which has its own SELECT policy
on `staff` for that purpose. The claim is missing on tokens that predate the hook, and
the app falls back to the query in that case.

This is a UI cache and nothing more. Every policy and the bookings trigger call
`current_staff()`, which reads the live table, so a revoked permission is refused on
the very next statement whatever the token says.

What it cannot do on its own is tell the person. A token lives about an hour, and Auth
only reruns the hook when it reissues one, so an edit the owner saves would keep showing
the old buttons on that person's screen until then. That is what happened to a check-in
account that signed in 25 seconds before its permissions were changed: the database
refused every click, the buttons stayed. The fix is `StaffClaimsSync`
(`components/app/staff-claims-sync.tsx`), mounted once by the `(app)` layout: it
subscribes to the account's own `staff` row over Realtime (`staff` is in the
publication for this; `staff_select` already lets an account read its own row) and, on
UPDATE, calls `auth.refreshSession()`. Refreshing reruns the hook, the new claims land
in the auth cookie, and `router.refresh()` re-renders the server tree from them. Each
time the subscription joins (first load, or after a reconnect) it also compares the
row's `updated_at` with the token's `iat` and refreshes if the row is newer, so a
change that landed while the laptop was asleep is caught too.

## Realtime

Screens that staff watch (bookings, messages, the payments ledger, a kiosk's caja)
update over a Realtime `postgres_changes` subscription instead of a reload. Two things
have to be true in the database for that to work.

**Published tables.** Postgres only emits changes for tables in the `supabase_realtime`
publication. Currently: `bookings`, `kiosks`, `sms_messages`, `whatsapp_messages`,
`stripe_transactions`, `stripe_refunds`, `cash_sales`, `staff`. A new live screen needs
its table added in a migration, or the client subscribes to silence. `staff` is not
there for a screen: each signed-in account watches its own row so a permission edit can
refresh its access token (see "The staff row in the access token" above).

**Replica identity.** `bookings`, `stripe_transactions`, `stripe_refunds` and
`cash_sales` are `REPLICA IDENTITY FULL`. At the default identity a DELETE writes only
the primary key to the WAL, which is not enough to match a subscription filter such as
`business_id=eq.<id>`, so filtered subscribers never hear about deletions. That was a
real bug: managers and check-in staff kept showing a booking another desk had deleted,
while owners (who subscribe unfiltered) saw it go. INSERT and UPDATE were never
affected, their payloads are complete either way.

**Scoping is RLS, same as a read.** A subscription runs the table's SELECT policy per
subscriber, so an owner streams every business, a manager only their own, a kiosk only
its own. Client-side `filter:` arguments are an efficiency (they stop one business's
traffic from waking another's screen), never a security boundary.

**On the client**, prefer `useLiveRefresh` (`src/lib/realtime/use-live-refresh.ts`) for
server-rendered screens: it subscribes for the signal and lets `router.refresh()` fetch
the answer, so the query stays in Postgres and there is no second copy of the filter and
paging logic in the browser. Screens that hold their rows in client state (the bookings
list, messages) subscribe directly and patch their own state.

`kiosk_events` (kiosk card flow v2) is published too, inserts only, for a future live kiosks
screen; nothing subscribes to it yet.

## Conventions

- UUID primary keys (`gen_random_uuid()`); `bigint identity` only for `audit_log`.
- Timestamps are `timestamptz`; `created_at` / `updated_at` on every table.
- Money is integer `*_cents`; never floats.
- Business operating timezone is `America/New_York` (see `businesses.timezone`).
