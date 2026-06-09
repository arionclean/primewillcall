# Architecture

How the app is wired: routing, the request lifecycle, data flow, and the patterns to
reuse. Pair this with [`DATABASE.md`](DATABASE.md) for the data layer and
[`../CLAUDE.md`](../CLAUDE.md) for the non-negotiable rules.

## Request lifecycle

1. `middleware.ts` runs on `/dashboard`, `/bookings`, `/schedule`, `/admin/*`, and
   `/login`. It refreshes the Supabase auth cookie, redirects signed-out users to
   `/login?next=...`, and bounces signed-in users away from `/login`.
2. The `(app)/layout.tsx` server layout re-checks auth, loads the caller's `staff` row,
   and renders the shared `AppShell` (topbar + sidebar + global search). Unlinked or
   inactive accounts are handled here.
3. The page (a server component) fetches its data with the user-scoped server client.
   RLS decides what comes back.
4. Interactive pieces are client components hydrated with that server data.

Auth is therefore enforced in three places: middleware, the app layout, and RLS. Role
gating adds a fourth layer (see below).

## Routes

All app screens live in the `(app)` route group so they share the shell and auth gate.

| Path | Who | Notes |
| --- | --- | --- |
| `/dashboard` | all | KPIs, today's bookings (realtime), tours snapshot, onboarding CTAs |
| `/dashboard/debug` | all | "what the server sees" for the session |
| `/bookings` | all | date-scoped list, privacy mode, tour filter, search, edit modal |
| `/schedule` | all (RLS gates writes) | new-booking form |
| `/admin/tours` | owner + manager | owner sees master tours; manager sees only their tours |
| `/admin/tours/[id]` | owner + manager | owner edits the master; manager edits name + prices |
| `/admin/tours/[id]/variants/new` | owner | add a business's copy of a tour |
| `/admin/businesses` | owner | list / new / edit (own layout gate) |
| `/admin/staff` | owner | list / new / edit; owner rows are not editable here |
| `/login` | public | client sign-in; redirects by `next` param or to `/dashboard` |
| `/api/auth/signout` | POST | clears the session |
| `/api/bookings/[id]/check-in` | POST | sets `checked_in` + stamps staff |
| `/api/places/autocomplete`, `/api/places/details` | server | Google Places proxy |

Routes prefixed with `_` (`app/_archive`, `components/_archive`) are not routed by Next
and exist only as reference to the old Bubble implementation.

## Data flow

- **Read**: server component → `getSupabaseServerClient()` → typed rows → props into a
  client component. Example: `bookings/page.tsx` computes the day window and the
  role-scoped tour options, then renders `bookings/list.tsx`.
- **Realtime**: lists that must stay live (dashboard bookings, the bookings list)
  subscribe to `postgres_changes` on `bookings` via the browser client and re-fetch the
  current window on any change.
- **Write (default)**: a `"use server"` action validates input and returns
  `{ error?, fieldErrors?, saved? }`, consumed in the form with `useActionState`.
  Examples: `schedule/actions.ts`, `admin/**/actions.ts`, `tours/[id]/manager-actions.ts`.
- **Write (documented exception)**: the rich bookings edit / check-in / delete in
  `bookings/list.tsx` mutate directly with the browser client for optimistic UX. Safe
  because RLS authorizes each statement. Do not copy this pattern for new flows unless
  you specifically need optimistic in-place edits.

## Role gating (layered, never a single check)

1. `AppSidebar` only renders links a role can use.
2. The section's `layout.tsx` redirects disallowed roles (e.g. `admin/businesses`,
   `admin/staff` are owner-only; `admin/tours/page.tsx` and `[id]/page.tsx` branch owner
   vs manager views).
3. Server actions re-verify role/business before writing.
4. RLS is the final backstop.

Special case: staff editing refuses to render the edit form for an `owner` row, and the
staff create form omits the `owner` option, so owners cannot be created or edited here.

## Shared building blocks

- **Shell**: `components/app/app-shell.tsx` composes `app-topbar`, `app-sidebar`, and
  `global-search`. Mobile uses `mobile-nav.tsx` (a drawer); the desktop sidebar is
  hidden below `md`.
- **Global search**: `global-search.tsx` (Cmd/Ctrl+K) searches customers and their
  bookings, RLS-scoped, and deep-links to `/bookings?date=...&booking=...` which
  highlights the row.
- **Forms**: `FormSection` (title outside the card) + `Field` (label, hint, error) +
  primitives (`Input`, `Textarea`, `Select`, `PhoneInput`, `DateField`).
- **Dates and times**: `DateField` forces the native calendar (no typing). Booking times
  are picked from `tour_timeslots`, never a free time input. Convert
  `America/New_York` local date + slot to UTC before saving.
- **Maps**: `meeting-point-picker` + `meeting-point-map` use Leaflet + CARTO tiles and
  the Google Places proxy. The Google key stays server-side.
- **Formatters**: `lib/dashboard/queries.ts` exports `formatCents`, `formatTimeRange`,
  `formatPax`, and the today-window helpers. Reuse them rather than re-implementing.

## Supabase clients

`lib/supabase/client.ts` (browser), `server.ts` (RSC + actions + route handlers), and
`admin.ts` (service role, server-only, bypasses RLS, for Auth admin work only). See
CLAUDE.md for which to use where.
