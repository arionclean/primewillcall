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

Non-owner staff also carry per-person booking permissions
(`staff.can_create_bookings / can_edit_bookings / can_check_in / can_delete_bookings /
can_add_to_peek`), owner-editable in the "Permissions" section of `/admin/staff/[id]`.
Owners always have all of them. Enforcement is layered (UI, server action, RLS, plus a
bookings trigger that limits check-in-only accounts to the check-in + peek stamps);
see `docs/DATABASE.md`.

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
      webhooks/twilio/sms/     POST inbound SMS. Superseded by the twilio-inbound-sms edge
                               function; still live until Twilio's console is repointed.
      places/autocomplete/     Google Places proxy (keeps key server-side)
      places/details/          Google Place details proxy
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
    utils.ts                   cn()
  middleware.ts                session refresh + auth redirect for app routes
supabase/migrations/           timestamped SQL migrations (source of truth for schema)
supabase/functions/            Deno edge functions. Everything public, webhook-driven or
                               scheduled lives here, NOT in a Next route: stripe-webhook,
                               twilio-inbound-sms, sms-send, sms-sync, gp-voucher-vision,
                               run-booking-automations, dispatch-scheduled-messages,
                               enqueue-review-asks, email-booking-parse, kiosk-*,
                               gp-slots, gp-validate, gp-book, xano-booking-sync,
                               whatsapp-send, whatsapp-templates.
                               `_shared/` holds the modules they share (sms.ts,
                               whatsapp.ts, staff-auth.ts, gp.ts, ny-time.ts,
                               parse-booking-email.ts).
supabase/config.toml           per-function `verify_jwt`. Not optional: the CLI defaults a
                               function to JWT ON, which breaks any caller that cannot send
                               a Supabase token (pg_cron sends only `x-cron-secret`, Twilio
                               only `X-Twilio-Signature`). Add an entry for every new
                               function before deploying it.
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
- **Submit CTAs**: every one-shot write (save, confirm, resolve, refund, delete) uses
  `SubmitButton` (`components/ui/submit-button.tsx`). It reads `useFormStatus()` from its
  own parent form, so it disables itself and swaps its label for a centered spinner while
  the action is in flight. That is what stops a double click from sending the write twice.
  It works for both plain `<form action={serverAction}>` and `useActionState` forms, so
  the button needs no `isPending` prop drilled into it. Pass extra conditions through
  `disabled` (they are OR'd with pending). The label stays in the layout while hidden, so
  the button never resizes. Do NOT use it for **optimistic toggles** (the check-in
  checkbox, `/availability` slot buttons): those flip local state instantly and a second
  click is a legitimate opposite action, not a duplicate.
- **Live screens**: anything staff watch (bookings, messages, payments, caja) updates
  over a Realtime `postgres_changes` subscription, never a manual reload. For a
  server-rendered screen use `useLiveRefresh` (`lib/realtime/use-live-refresh.ts`): it
  subscribes for the signal and lets `router.refresh()` fetch the answer, so the query
  stays in Postgres. Screens holding rows in client state subscribe directly and patch
  that state. A new live table must be added to the `supabase_realtime` publication in a
  migration, and set `REPLICA IDENTITY FULL` if any subscriber uses a `filter:` (a DELETE
  otherwise carries only the primary key and never matches). RLS scopes the stream; the
  filter is an efficiency, not a boundary. See "Realtime" in `docs/DATABASE.md`.
- **Dates**: `DateField` opens the native calendar and blocks manual typing. Booking
  times come from the tour's configured `tour_timeslots`, never a free time input.
- **Timezone**: business time is `America/New_York`. Convert local date + slot time to
  UTC before storing (`nyLocalToUtcIso` in `schedule/actions.ts` and the bookings edit).
  Display with `Intl.DateTimeFormat({ timeZone: "America/New_York" })`.
- **Money**: integer cents in the DB. Format with `formatCents` in `lib/dashboard/queries.ts`.
- **Google Places**: only through `/api/places/*`. The key never reaches the browser.
- **Creating a booking**: always through the `create_booking()` Postgres function, never
  hand-rolled inserts. It writes the customer + booking in one transaction and takes the
  slot duration, the tier/Groupon prices and the UTC timestamps from the database, so a
  caller can only send quantities. Both the staff `/schedule` form and the public
  `gp-book` edge function use it. It is `SECURITY INVOKER`, so RLS still scopes the
  caller. See "create_booking()" in [`docs/DATABASE.md`](docs/DATABASE.md).
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
- **Deploy regions**: `vercel.json` pins serverless functions to `pdx1` (Portland) to sit
  next to the Supabase project in `us-west-2`. A page makes several queries and pays the
  round trip on each, so being near the database beats being near the browser. Middleware
  is unaffected (it runs on the edge everywhere and makes no database call). If the
  Supabase project is ever moved to `us-east-1`, change or delete this file.
- Always keep it green: `npx tsc --noEmit` (0 errors) and `npm run lint` (0 warnings)
  before considering a change done.
- There is no debug screen in the app: nothing internal (auth ids, roles, raw errors)
  is ever put in front of staff. To see what the server sees for a session, query
  `current_staff()` in Supabase, or read the server log.
- **RLS denial looks like "no rows" or a 42501 error, not a crash.** If a write
  silently does nothing or a list is empty for a role that should see data, check the
  policy in `docs/DATABASE.md` and confirm `current_staff()` returns what you expect.
- Test accounts (dev Supabase): owner `sky@gmail.com` (was
  `alegarcialuis98@gmail.com`); manager `skymanager@gmail.com` (Miami Skyline
  Cruises); check-in `kiosk1@gmail.com`. The owner address is not a mailbox Prime
  controls, so password resets and auth mail do not reach anyone here. The dashboard
  user panel only offers emailed recovery, so set an owner password with the Auth
  admin API (`PUT /auth/v1/admin/users/<id>` with the service role key) instead.

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
  an optional **wait** (`messaging_rules.delay_minutes`). The trigger is a **US / non US**
  pair (`new_booking` / `new_booking_non_us`), split on the customer's phone by
  `classifyPhone` in `_shared/phone.ts`; the two are exclusive, so exactly one fires per
  booking and nobody is double-messaged. There is no "any phone" trigger on purpose.
  "US" is the +1 country code, so Canada and the Caribbean count as US. The engine is
  **all in Supabase**:
  the `on_native_booking_created` trigger calls the `run-booking-automations` edge function,
  which only ever ENQUEUES into `scheduled_messages`; `dispatch-scheduled-messages`
  (pg_cron) is the single thing that calls Twilio and it enforces the global hourly cap.
  `messaging_settings.automations_enabled` is ON. Full model + go-live checklist in
  [`docs/messaging-automations.md`](docs/messaging-automations.md).
- **WhatsApp** shares that engine but not its rules. Meta lets a business open a
  conversation only with an approved template; when the customer replies, a **24-hour
  window** opens in which free-form text is allowed, and each new reply restarts it.
  So the channel is built around that window, not around a send call:
  `whatsapp_messages.direction` records inbound replies (Twilio posts WhatsApp to the
  same `twilio-inbound-sms` webhook, addressed `whatsapp:+1...`), the inbound row is
  what opens the window, and `whatsapp_window_open(phone)` is the single answer to
  "may we write freely?". Every send goes through `sendWhatsapp` in
  `_shared/whatsapp.ts`, which reads the window and picks free-form or template
  itself, so a caller can never collect a Twilio 63016 by guessing. `whatsapp-send`
  is the staff-facing entry point, `whatsapp-templates` is the Twilio Content catalog
  (list + submit for approval). The sender `+17868226594` posts incoming messages to
  `twilio-inbound-sms`, set through the Messaging v2 Senders API (the console's sender
  form will not save without a public "Profile about" and was 404ing anyway).
  The staff Messages screen is one thread per person across both channels, fed by the
  `messaging_conversations` (searchable, keyset paged) and `messaging_thread` RPCs.
  **Not live**: the `WhatsApp booking confirmation` rule is switched off until Meta
  approves the general template. See [`docs/whatsapp.md`](docs/whatsapp.md).
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
  "Payments (Stripe)". The matcher can be graded against live Xano by the **shadow test**
  (`gp_shadow_runs` + the `gp-shadow-compare` edge function); it is read-only with respect
  to Xano and creates no bookings. Its **`/admin/gp-shadow` page was removed** in the
  production cleanup, since a screen comparing us to Xano is migration scaffolding, not
  something the app should show. The table and edge function are untouched, so the
  results are still readable by SQL. Feeding it also needs one additive hook in Xano's
  `vision_v4` post_process, which is a live-Xano write and is **not applied yet**. See
  [`docs/gp-shadow-test.md`](docs/gp-shadow-test.md).
- `/availability` (owner + business manager) opens/closes booking times per day via
  `tour_slot_closures`; the `gp-slots` and `gp-book` edge functions respect closures. The
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
  endpoints. The `kiosk-connection-token` (Terminal connection token) and
  `kiosk-payment-intent` (card_present DIRECT charge with the platform fee) edge functions both
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
  per-business Connect onboarding on `/admin/businesses/[id]` (a single "Set up payments
  with Stripe" CTA that creates the account and hands off to Stripe's hosted onboarding,
  then a plain-language status line plus Express dashboard login and refresh; buttons
  only, no account-id input anywhere); a single global platform fee
  (`STRIPE_PLATFORM_FEE_BPS`, default 25 bps = 0.25%, historically the Connect fee passed
  through, now margin on any fee-free account); a single webhook, the **`stripe-webhook`
  Supabase edge function** (official signature verify, `stripe_events` idempotency, handles
  checkout/payment_intent/charge/dispute/`account.updated`); the ledger tables
  `stripe_transactions` / `stripe_refunds` /
  `stripe_events`; and the public `/gp` Groupon checkout now creates a real Checkout Session
  (with a graceful manual-collection fallback when a business is not yet onboarded). Shared
  **Stripe runs entirely in Supabase.** Four functions: `stripe-webhook` (Stripe calls it),
  `gp-book` (public checkout), `stripe-connect` (connected-account management, from the
  Payments panel), and `payments` (card + cash refunds, move-sale, booking payment links).
  The last two are called from the browser with the staff member's own JWT, which
  `requireStaff` turns into their staff row before any role check. Vercel holds **no Stripe
  key at all**: `src/lib/stripe/server.ts`, the Connect server actions, the payments server
  actions and the payment-link route are deleted. Supabase secrets: `STRIPE_SECRET_KEY`
  (Prime's PLATFORM key), `STRIPE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_SECRET_CONNECTED`,
  `STRIPE_PLATFORM_FEE_BPS`, `APP_URL` (onboarding return + checkout redirect links), and
  `REFUND_PIN`. A test key against a live connected account is the failure that reads "the
  provided key does not have access to account acct_...". See `docs/DATABASE.md`
  "Payments (Stripe)".
  Also built: the **`/admin/payments`** transactions dashboard (owner + business_manager;
  check_in redirected out) with a date-range + owner business filter and DB-aggregated
  totals via the `stripe_payments_summary` RPC; a **refund** action
  (`admin/payments/actions.ts`: owner or the charge's manager; refunds on the connected
  account, records `stripe_refunds`, webhook reconciles); and **customer payment links**
  (`POST /api/bookings/[id]/payment-link` + the "Payment link" button in the booking edit
  modal) that mint a Checkout link for a booking to send the customer.
  **Account shape**: accounts are created with controller properties
  (`connectControllerParams()`), never `type: "express"` (the shorthand puts Stripe's
  Connect fees, $2 per active account + 0.25% of payout volume, on PRIME). The business
  keeps the same Express dashboard and Stripe-run onboarding; Stripe just bills it instead
  of us. The Xano-era fleet is still on the old shape, and Stripe cannot convert an account,
  so each one migrates through the owner-only flow on `/admin/businesses/[id]`: create
  replacement account -> onboard -> switch over, using
  `businesses.stripe_account_id_pending` / `_legacy` / `stripe_fees_payer`. Both accounts
  run side by side, so the switch is one gated row update with no window where charges fail.
  **Still to do**: the kiosk Terminal side of that migration (Locations and readers belong
  to an account, so a migrated kiosk business needs a new Location + re-registered readers;
  deliberately not built until there are accounts to point at); taking payment inline in the
  internal `/schedule` new-booking flow; and saved-customer flows
  (`customers.stripe_customer_id` is still a placeholder). Go-live config (platform key,
  register the two webhook endpoints, connect each business) is the remaining operational
  step. Runbook in [`docs/stripe-fee-free-accounts.md`](docs/stripe-fee-free-accounts.md).
