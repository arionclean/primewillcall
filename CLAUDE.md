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
- `check_in` — desk staff for one business. Sees bookings on assigned tours and checks
  guests in from the Bookings page (inline check-in checkbox). Lands on `/dashboard`.

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
      admin/
        layout.tsx             any active staff allowed; sub-sections gate further
        businesses/            owner-only (own layout gate). list/new/[id] + actions
        tours/                 owner sees master tours; manager sees their tours only
          [id]/                edit-form (owner) vs manager-edit-form (manager)
          [id]/variants/new/   owner: add a business's copy of a tour
        staff/                 owner-only. list/new/[id] + actions
    api/
      auth/signout/            POST sign out
      bookings/[id]/check-in/  POST mark checked in
      places/autocomplete/     Google Places proxy (keeps key server-side)
      places/details/          Google Place details proxy
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
- `kiosks` / `kiosk_tours` tables still exist in the DB but are unused by the app
  (legacy from the original schema). Slated for removal once nothing references them.
- Stripe rework is the final phase. `bookings` already has `stripe_payment_intent_id`
  and `customers` has `stripe_customer_id` as placeholders; payments are not wired yet.
