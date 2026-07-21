# CLAUDE.md

Guidance for working in this repo. Read this first. It is the source of truth for how
the project is structured and the conventions every change must follow.

## What this is

PrimeWillCall is an operations platform for Prime, a tour / scheduled-experience
operator. Prime is the single platform owner and runs multiple businesses. Staff book
guests onto scheduled tours, priced per passenger (adult / child / infant tiers).

Migrating from a live Bubble.io + Xano stack to Supabase + Vercel. The old stack is
still in production, so the migration is additive and careful (see "Hard rules").

Stack: Next.js 15 App Router (Turbopack), React 19, TypeScript strict, Tailwind v4,
shadcn-style primitives, lucide-react, Supabase (Postgres + RLS + Auth + Storage +
Realtime). Supabase project id: `qbnizuhozzwkiitfkjee`.

## Hard rules (do not break)

1. **No em dashes** in any output, code, or copy. Use periods, commas, or parentheses.
2. **Never run destructive operations on Xano.** Xano is the live production backend.
   Read-only is fine; never write, modify, or delete without explicit confirmation.
3. **`SUPABASE_SERVICE_ROLE_KEY` is server-only.** It bypasses RLS. Never import the
   admin client into a client component, never log it, never put it in the browser.
4. **Phone fields use a mask.** Display US phones as `(XXX) XXX-XXXX` while typing,
   store digits only. Use `PhoneInput` from `@/components/ui/phone-input`.
5. **Scope by RLS, not by client filtering.** Queries run as the signed-in user; the
   database decides what they can see. Do not rely on hiding rows in the UI for
   security (hiding in the UI is fine for ergonomics, but the policy is the guarantee).
6. **Build for non-technical users.** Clean, intuitive UX. Never expose internal jargon
   like "variant" or "master tour" to managers or staff.

## Roles

`staff.role` enum, three values:

- `owner` — Prime. Platform-wide. Manages businesses, tours, staff, everything.
- `business_manager` — belongs to one business (`staff.business_id`). Manages that
  business's bookings, customers, and its own copy of each assigned tour (name + prices).
- `check_in` — desk staff for one business (the kiosk accounts). Sees bookings on
  assigned tours, checks guests in, and can create bookings on those tours from
  `/schedule`. Lands on `/bookings` (no dashboard; the sidebar Manifest shows
  today's remaining check-ins per departure).

Non-owner staff also carry four per-person booking permissions
(`staff.can_create_bookings / can_edit_bookings / can_check_in / can_delete_bookings`),
owner-editable in the "Permissions" section of `/admin/staff/[id]`. Owners always have
all four. Enforcement is layered (UI, server action, RLS, plus a bookings trigger that
limits check-in-only accounts to the check-in stamp); see `docs/DATABASE.md`.

A Postgres trigger links `auth.users` to a `staff` row by email on sign-up. The
`current_staff()` SECURITY DEFINER function returns `(staff_id, role, business_id)` and
is the basis for every RLS policy.

## Directory map

```
src/
  app/
    (app)/                     route group: shared shell + auth gate (layout.tsx)
      dashboard/               KPIs, today's bookings, tours snapshot
        debug/                 "what the server sees" account debug page
      bookings/                bookings list (page.tsx server) + list.tsx (rich client)
      schedule/                new-booking form (page + form.tsx + actions.ts)
      availability/            per-day open/close of booking times (owner + manager);
                               writes tour_slot_closures, which /gp respects
      admin/
        layout.tsx             any active staff allowed; sub-sections gate further
        businesses/            owner-only (own layout gate). list/new/[id] + actions
        tours/                 owner sees master tours; manager sees their tours only
          [id]/                edit-form (owner) vs manager-edit-form (manager)
          [id]/variants/new/   owner: add a business's copy of a tour
        staff/                 owner-only. list/new/[id] + actions
        unmatched/             owner-only. OTA email review queue (page + actions)
        groupon/               owner-only. per-product Groupon convenience fee config
        payments/              owner + manager. Stripe charges ledger + refunds
    api/
      auth/signout/            POST sign out
      bookings/[id]/check-in/  POST mark checked in
      bookings/[id]/payment-link/  POST mint a Stripe Checkout link for a booking
      kiosk/                   Stripe Terminal: connection-token + payment-intent (PrimeKiosk)
      stripe/webhook/          POST Stripe webhook (platform + Connect events)
      places/autocomplete/     Google Places proxy (keeps key server-side)
      places/details/          Google Place details proxy
      gp/                      PUBLIC: validate (vision) + slots + book for /gp
    gp/                        PUBLIC voucher-redemption page (no auth; outside (app))
    booking/[token]/           PUBLIC guest booking-details page (no auth; outside (app))
    login/                     sign-in (client); middleware redirects here when signed out
    layout.tsx, page.tsx       root layout + landing redirect
  components/
    app/                       app-shell, app-topbar, app-sidebar, mobile-nav, global-search
    dashboard/                 kpi-strip, todays-bookings, tours-panel, onboarding-cta
    admin/                     meeting-point-picker, meeting-point-map
    ui/                        primitives: button, input, field, form-section, select,
                               textarea, badge, card, phone-input, date-field
  lib/
    supabase/                  client (browser), server (RSC/actions), admin (service role),
                               database.types.ts (generated)
    dashboard/queries.ts       dashboard fetchers + shared formatters (cents, time, pax)
    gp/vision.ts               typed client for the gp-voucher-vision edge function
    utils.ts                   cn()
  middleware.ts                session refresh + auth redirect for app routes
supabase/migrations/           timestamped SQL migrations (source of truth for schema)
docs/                          ARCHITECTURE, DATABASE, platform-migration, shadcn-foundation
scripts/                       import_legacy_bookings.py (one-way Xano -> Supabase tunnel)
src/app/_archive, src/components/_archive   legacy Bubble pages, kept as reference only.
                               Underscore prefix means Next does NOT route them. Do not
                               import from here in live code.
```

## Supabase clients (pick the right one)

- `getSupabaseBrowserClient()` (`lib/supabase/client.ts`) — client components. Runs as
  the user, RLS enforced.
- `getSupabaseServerClient()` (`lib/supabase/server.ts`) — server components, server
  actions, route handlers. Runs as the user, RLS enforced.
- `getSupabaseAdminClient()` (`lib/supabase/admin.ts`) — server-only, service role,
  **bypasses RLS**. Use only for Auth admin work (create/invite/update/delete users).
  Never in a client component.

## Patterns to follow

- **Auth/role lookup**: server components get the signed-in user + their staff row from
  `getCurrentStaff()` (`lib/auth.ts`), which is `cache()`d so the `(app)` layout and the
  page it renders share a single `getUser()` + staff round-trip per request instead of
  each doing their own. Each route group has a `loading.tsx` skeleton, so navigation
  paints instantly while the page server-renders.
- **Reads**: server component fetches with `getSupabaseServerClient()`, passes typed
  data to client components. Live-updating lists (bookings) re-fetch via a Realtime
  `postgres_changes` subscription on the browser client.
- **Writes**: prefer a server action (`"use server"`) returning
  `{ error?, fieldErrors?, saved? }`, consumed with `useActionState`. The rich bookings
  edit/check-in/delete use direct browser-client mutations (RLS protects them) for
  optimistic UX; that is the documented exception, not the default.
- **Role gating is layered**, never a single check:
  1. Sidebar hides links the role cannot use.
  2. The route's `layout.tsx` redirects disallowed roles.
  3. The server action re-checks the role/business before writing.
  4. RLS is the final backstop.
  Owner-protection for staff also refuses to render the edit form for an `owner` row.
- **Forms**: wrap sections in `FormSection` (title outside the card), fields in `Field`
  (label + error + hint). Use `Input`, `Textarea`, `Select`, `PhoneInput`, `DateField`.
- **Dates**: `DateField` opens the native calendar and blocks manual typing. Booking
  times come from the tour's configured `tour_timeslots`, never a free time input.
- **Timezone**: business time is `America/New_York`. Convert local date + slot time to
  UTC before storing (`nyLocalToUtcIso` in `schedule/actions.ts` and the bookings edit).
  Display with `Intl.DateTimeFormat({ timeZone: "America/New_York" })`.
- **Money**: integer cents in the DB. Format with `formatCents` in `lib/dashboard/queries.ts`.
- **Google Places**: only through `/api/places/*`. The key never reaches the browser.
- **Analytics / aggregation**: never fetch-all-and-sum-in-JS. Supabase caps a single
  read at **1000 rows**, so a naive month query silently truncates. Push the
  aggregation into a Postgres function (RPC), e.g. `dashboard_monthly_guests`, which
  does `SUM`/`GROUP BY` in the database (using the `starts_at` index) and returns a
  handful of rows. Keep such functions `SECURITY INVOKER` so RLS still scopes them by
  business. This is the pattern for reports and any future dashboards.

## The data model in one paragraph

`tours` are Prime-owned masters (capacity, timeslots, meeting point, instructions).
Each business gets a `business_tours` row (its own name + `is_active`) that links a
business to a master tour. Pricing lives in `tour_pax_tiers` (per `business_tour`,
adult/child/infant prices). `bookings` reference a `business_tour` and a `customer`,
carry pax counts + a `tour_pax_breakdown` snapshot + `total_cents`. Full schema and the
RLS policy for every table are in [`docs/DATABASE.md`](docs/DATABASE.md).

## Running and debugging

- Dev server: `npm run dev` (port 3000). In the Claude app, use the preview
  (`.claude/launch.json` is configured). Only one process can hold port 3000 at a time;
  do not run `npm run dev` in a terminal and the preview at the same time.
- Always keep it green: `npx tsc --noEmit` (0 errors) and `npm run lint` (0 warnings)
  before considering a change done.
- `/dashboard/debug` shows exactly what the server sees for the current session (auth
  id, linked staff row, role, business). First stop when auth or scoping looks wrong.
- **RLS denial looks like "no rows" or a 42501 error, not a crash.** If a write
  silently does nothing or a list is empty for a role that should see data, check the
  policy in `docs/DATABASE.md` and confirm `current_staff()` returns what you expect.
- Test accounts (dev Supabase): owner `alegarcialuis98@gmail.com`; manager
  `skymanager@gmail.com` (Miami Skyline Cruises); check-in `kiosk1@gmail.com`.

## Adding a feature (checklist)

1. New columns or tables go in a new timestamped migration under
   `supabase/migrations/`, then regenerate `lib/supabase/database.types.ts`.
2. Add RLS policies for every new table (owner / manager-by-business / check-in as
   appropriate). No table ships without policies.
3. Build reads in a server component, writes in a server action with field validation.
4. Apply the layered role gating above.
5. Keep copy free of internal jargon and em dashes; mask phones; use the shared primitives.
6. Verify in the preview, then confirm `tsc` and `lint` are clean.

## Known gaps / roadmap

- Customers list (scoped by business) not built.
- Profile / settings not built.
- **Messaging automations** (`/admin/messaging`) are built: owner rules grouped as
  trigger (a new booking, per product) plus one or more actions (SMS / WhatsApp), each with
  an optional **wait** (`messaging_rules.delay_minutes`). The engine
  (`runNewBookingRules` in `src/lib/sms/rules.ts`) sends immediate actions inline and
  enqueues delayed ones into `scheduled_messages`; the `dispatch-scheduled-messages` edge
  function (invoked by pg_cron) sends the due ones. **Not live yet**: booking creation only
  fires the automations when `MESSAGING_AUTOMATIONS_ENABLED=true` (wired into `/schedule`,
  still to wire `/api/gp/book`), and the cron + Twilio secrets must be set. Full model +
  go-live checklist in [`docs/messaging-automations.md`](docs/messaging-automations.md).
- **Review automation** (post-tour rating funnel) is built and deployed but
  **switched OFF**: 3h after a tour ends the customer is texted for a 1-5 rating;
  a 5 gets the Google review link (plus one 24h nudge if never clicked), a 1-4 gets
  a private "what could we have done better" and never reaches Google. A 24h re-ask
  chases anyone who never replied (that follow-up earns a lot of the responses).
  It is a **fixed flow, not an editable automation**: it branches on the reply and
  cancels itself, which `messaging_rules` cannot express, so the copy lives in
  `src/lib/reviews/copy.ts` and `/admin/messaging` shows the four steps read-only
  with one on/off switch. Only checked-in guests qualify; un-checking or cancelling
  a booking kills the funnel via the `cancel_review_funnel` DB trigger (unchecking
  is a direct browser-client mutation, so app-side hooks would be bypassed). A reply
  only counts as a rating if the last thing we sent was the ask. The sweep is
  `enqueue-review-asks`, the reply branch is `src/lib/reviews/*` off the Twilio
  webhook, and `/r/<token>` is the click-tracked link. It has its **own** kill
  switch, `messaging_settings.review_automation_enabled` (default false), because
  `automations_enabled` is already true and Xano still runs the same funnel plus
  still receives every inbound SMS via the webhook mirror, so turning this on early
  double-texts customers. Five brakes, go-live checklist and known gaps in
  [`docs/review-automation.md`](docs/review-automation.md). The `/reviews`
  management section (the other half of the Xano feature) is deliberately not built.
- **Groupon `/gp`** (public voucher redemption) is built: upload -> vision match -> details
  -> pending booking on the `groupon` channel. Owner sets the per-product fee at
  `/admin/groupon` (`business_tours.groupon_fee_cents`). Vision runs in the
  `gp-voucher-vision` edge function (port of Xano vision_v3: Google OCR -> Groq fallback
  -> deterministic alias match -> Groq extraction); its keys (`GOOGLE_API_KEY`,
  `GROQ_API_KEY`, optional `OPENAI_API_KEY`) are Supabase function secrets. The checkout
  step now creates a real Stripe Checkout Session (direct charge on the business's
  connected account + platform fee), with a graceful manual-collection fallback when the
  business is not yet Stripe-onboarded. The owner still marks each Groupon voucher redeemed
  (owner-only "Redeem" / "Redeemed" toggle on Groupon rows in the bookings list,
  `bookings.groupon_redeemed_at`) after redeeming it on Groupon's own platform. See the
  Stripe entry below and [`docs/DATABASE.md`](docs/DATABASE.md) "Groupon convenience fee" +
  "Payments (Stripe)".
- `/availability` (owner + business manager) opens/closes booking times per day via
  `tour_slot_closures`; `/api/gp/slots` and `/api/gp/book` respect closures. The
  internal `/schedule` booking form does NOT block closed times (staff can override);
  wire that in if the business asks for it.
- `/analytics` is built, organized as in-page tabs (`analytics-tabs.tsx`, client state,
  both panels stay mounted so their filters survive tab switches):
  - **Sources & products** (`analytics-view.tsx`, RLS-scoped via the
    `analytics_source_tour` RPC = source x tour x business aggregated in the DB): a totals
    header (guests / bookings / OTA + Organic split), a Group-by toggle (Source <-> Tour)
    with reverse drill-down, date range + presets, an OTA/Organic source filter, an
    owner-only business filter (auto-shown when the data spans 2+ businesses), and
    client-side CSV export.
  - **Monthly comparison** (`monthly-comparison.tsx`): pick a month/year + product chips
    and overlay two daily lines (SVG, hover tooltip) plus a Total / Lowest / Highest stats
    panel with % deltas. Comparison tools: **Compare to** (previous month or same month
    last year / YoY), **Measure** (pax or bookings), **View** (daily or cumulative
    month-to-date pacing). It compares the same elapsed day-range (the live month is
    month-to-date), is fed by the `analytics_daily_by_tour` RPC (daily pax + bookings per
    tour, aggregated in the DB), and refetches month/compare-to changes via the browser
    client (RLS-scoped). Revenue analytics wait on Stripe.
- **Public booking page `/booking/<token>`** is built: the link guests get after
  booking (replaces bked.io/booking/<token>). Tabs: Ticket (product, time, guest,
  pax), Meeting point (Open in Maps, address, departure time, tour instructions),
  Support (business `contact_email` + `phone`, both editable on the business form).
  Reads server-side with the service role by `bookings.public_token` (generated by
  default; Xano-synced bookings keep the token Xano emailed as
  `bookingConfirmation_id`). The legacy page's upsell section is intentionally NOT
  built yet (waits on Stripe). See "public_token" in
  [`docs/DATABASE.md`](docs/DATABASE.md).
- **Kiosk POS (Stripe Terminal)** is built: the PrimeKiosk tablet's card + cash sales,
  Supabase-native replacement for the Xano `connection-token_v6` / `payment-intent_v2`
  endpoints. `POST /api/kiosk/connection-token` (Terminal connection token) and
  `POST /api/kiosk/payment-intent` (card_present DIRECT charge with the platform fee) both
  resolve the connected account server-side from the tablet's `kiosk` tag via
  `kiosks.slug` (`src/lib/kiosk/resolve.ts`), so a caller can never choose which account
  to charge. Card sales record into `stripe_transactions` (source=`kiosk`) through the
  webhook; cash sales write `cash_sales`. Migration `kiosk_pos` adds the `kiosks`
  connect/terminal columns + `cash_sales`. Still needs go-live config (real Terminal
  Locations + kiosk->business mappings) and the tablet pointed here. `kiosk_tours` remains
  legacy/unused.
- **Payments (Stripe)** are largely built (Supabase-native replication of the live Xano
  Connect model; Xano is never written to). Model: Stripe Connect **direct charges** on each
  business's connected account with a platform `application_fee` (Prime's cut). Built:
  per-business Connect Express onboarding on `/admin/businesses/[id]` (create account,
  onboarding link, Express dashboard login, refresh status, owner-only "link existing
  `acct_...`"); a single global platform fee (`STRIPE_PLATFORM_FEE_BPS`, default 25 bps =
  0.25%, the Connect fee passed through); a single webhook at `/api/stripe/webhook` (official
  signature verify, `stripe_events` idempotency, handles checkout/payment_intent/charge/
  dispute/`account.updated`); the ledger tables `stripe_transactions` / `stripe_refunds` /
  `stripe_events`; and the public `/gp` Groupon checkout now creates a real Checkout Session
  (with a graceful manual-collection fallback when a business is not yet onboarded). Shared
  client + fee helpers in `src/lib/stripe/server.ts`. Requires env `STRIPE_SECRET_KEY`
  (Prime's PLATFORM key), `STRIPE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_SECRET_CONNECTED`,
  `STRIPE_PLATFORM_FEE_BPS`, `NEXT_PUBLIC_APP_URL`. See `docs/DATABASE.md` "Payments (Stripe)".
  Also built: the **`/admin/payments`** transactions dashboard (owner + business_manager;
  check_in redirected out) with a date-range + owner business filter and DB-aggregated
  totals via the `stripe_payments_summary` RPC; a **refund** action
  (`admin/payments/actions.ts`: owner or the charge's manager; refunds on the connected
  account, records `stripe_refunds`, webhook reconciles); and **customer payment links**
  (`POST /api/bookings/[id]/payment-link` + the "Payment link" button in the booking edit
  modal) that mint a Checkout link for a booking to send the customer.
  **Still to do**: taking payment inline in the internal `/schedule` new-booking flow, and
  saved-customer flows (`customers.stripe_customer_id` is still a placeholder). Go-live
  config (platform key, register the two webhook endpoints, connect each business) is the
  remaining operational step.
