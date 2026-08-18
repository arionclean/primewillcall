# Navigation speed + realtime plan

Goal: make moving between screens feel instant (Supabase-dashboard fast), and make
the money screens update live without a reload, the way the Bubble/Xano system did.

Nothing here changes behavior or data. It is all caching, transport, and subscriptions.

---

## Part 1. Why navigation feels slow today

Every sidebar click (even a soft client-side one) pays this, every single time:

| # | Cost | Where |
|---|------|-------|
| 1 | `supabase.auth.getUser()` = HTTPS call to Supabase Auth | `src/middleware.ts:44` |
| 2 | `getUser()` **again** (separate process, `cache()` only dedupes inside one render) | `src/lib/auth.ts:17` |
| 3 | `staff` row select | `src/lib/auth.ts:21` |
| 4 | owner only: `email_match_queue` count | `src/app/(app)/layout.tsx:28` |
| 5 | the page's own queries, all awaited before anything renders | each `page.tsx` |
| 6 | nothing is reused, so going back re-runs 1 to 5 | Next Router Cache is off for dynamic routes |

That is **two auth round trips plus three to six database queries per click**. The old
system was one page with hidden divs, so navigation cost zero network. This is the gap.

`src/app/(app)/loading.tsx` already hides the delay behind a skeleton, which is why it
does not feel broken. It still feels slow.

---

## Part 2. Realtime audit (what is live now, what is not)

Database publication `supabase_realtime` currently contains:
`bookings`, `kiosks` (`supabase/migrations/20260527120300_auth_link_and_rls.sql:467`),
and `sms_messages` (`supabase/migrations/20260707170000_sms_messaging.sql:101`).

| Screen | File | Realtime? | Notes |
|--------|------|-----------|-------|
| Bookings list | `src/app/(app)/bookings/list.tsx:709` | Yes | Works, but any event refetches the whole date range |
| Sidebar manifest | `src/components/app/sidebar-manifest.tsx:82` | Yes | Not filtered by business, so an owner refetches on every business's changes |
| Messages | `src/components/messages/messages-client.tsx:117` | Yes | Confirmed working: INSERT on `sms_messages` appends to the open thread and refreshes the conversation list, both inbound (webhook) and outbound |
| **Payments ledger** | `src/app/(app)/admin/payments/payments-view.tsx` | **No** | Only `router.refresh()` after *your own* refund. A sale or refund from another desk never appears |
| **Caja (drawer)** | `src/app/(app)/caja/caja-view.tsx` | **No** | A sale on the tablet does not show until reload. This is the worst one |
| Dashboard KPIs | `src/app/(app)/dashboard/page.tsx` | No | Static until reload |

Root blocker: **`stripe_transactions` and `cash_sales` are not in the realtime
publication at all**, so no amount of client code can make transactions live today.
That needs a migration first.

---

## Part 3. The plan

Ordered by value per unit of work. Each phase is shippable on its own.

### Phase 1. Stop paying for auth on every navigation  (DONE)

Biggest win, smallest change. `getUser()` calls the Supabase Auth server over the
network. `getClaims()` verifies the JWT locally with the project's public key, so it
costs microseconds instead of a round trip.

- `src/middleware.ts:44`: swap `getUser()` for `getClaims()`. Middleware only needs
  "is there a valid session", not the full user record.
- `src/lib/auth.ts:17`: same swap. Take `sub` from the claims, then do the staff select.

Shipped, and it went further than the two calls above. Several screens rolled
their own `getUser()` + staff select instead of calling `getCurrentStaff()`, so
`/admin/tours` was paying **four** auth round trips per click (middleware, the
(app) layout, the admin layout, the page). All of them now go through the one
cached helper:

`admin/layout.tsx`, `admin/businesses/layout.tsx`, `admin/staff/layout.tsx`,
`admin/groupon/layout.tsx`, `bookings/page.tsx`, `schedule/page.tsx`,
`admin/tours/page.tsx`, `admin/tours/[id]/page.tsx`, `schedule/actions.ts`,
`admin/groupon/actions.ts`, `admin/messaging/actions.ts`,
`admin/tours/[id]/manager-actions.ts`, `api/bookings/[id]/check-in/route.ts`,
`bookings/[id]/payment-link/route.ts`.

**Measured** (dev, same machine and session, median of 5 warm renders):

| Route | Before | After |
|---|---|---|
| `/dashboard` | 897ms | 554ms |
| `/bookings` | 842ms | 646ms |
| `/admin/tours` | 768ms | 488ms |
| `/admin/payments` | 867ms | 519ms |

Verified the gate did not get weaker: no cookies and a forged token both still
redirect to `/login?next=...`, and all 13 signed-in routes render 200.

**Phase 1b (optional, bigger).** Put `role` and `business_id` into the JWT with a
Supabase custom access token hook. Then `getCurrentStaff()` needs zero queries and the
layout is free. Requires care: the token only refreshes hourly, so a permission change
would lag. Worth doing later, not first.

### Phase 2. Turn the Next Router Cache back on  (DONE)

`next.config.ts`, add:

```ts
experimental: { staleTimes: { dynamic: 30, static: 180 } }
```

Next then reuses the rendered payload for 30s, so back/forward and re-clicking a screen
you just left is instant instead of a full re-render.

Verified: clicking Bookings, Dashboard, Bookings fired only **two** RSC requests.
The return trip to Bookings cost zero network.

One code change came with it. `bookings/list.tsx` received its rows as server
props and never re-read them on mount, so a cached page could have shown rows up
to 30s old. It now re-syncs on mount (the same thing the sidebar manifest already
did), so the cache never costs freshness.

### Phase 3. Client data cache (TanStack Query)

This is what actually produces the Supabase-dashboard feel: the screen paints from
memory immediately, then revalidates behind you.

New files:
- `src/lib/query/provider.tsx` : `QueryClientProvider`, `staleTime` 30s, `gcTime` 5min.
- `src/lib/query/keys.ts` : one place for every cache key (`bookings(range)`,
  `payments(filters)`, `caja(day, kiosk)`, `manifest(date)`).
- `src/lib/realtime/use-table-channel.ts` : shared hook. One Supabase channel per
  table, an optional filter, and it invalidates the query keys you hand it. Replaces the
  three hand-rolled `useEffect` subscriptions.

Touched:
- `src/app/(app)/layout.tsx` : mount the provider inside `AppShell`.
- `src/app/(app)/bookings/list.tsx:693` : the hand-written `refresh` + `setBookings`
  become `useQuery`, seeded with the server-rendered rows via `initialData`. First paint
  stays server-rendered (no flash), later visits come from cache.

### Phase 4. Realtime where it is missing (the priority)  (DONE)

**4a. Migration** `supabase/migrations/<ts>_realtime_payments.sql`:

```sql
alter publication supabase_realtime add table public.stripe_transactions;
alter publication supabase_realtime add table public.cash_sales;
alter table public.stripe_transactions replica identity full;
alter table public.cash_sales replica identity full;
```

RLS still scopes the stream, so a manager only receives their own business's rows and a
kiosk only its own. No policy changes needed.

**4b. `src/app/(app)/admin/payments/payments-view.tsx`**
Subscribe to `stripe_transactions`, `stripe_refunds` and `cash_sales`, invalidate the
payments query. New sales, refunds from any desk, and webhook-settled charges appear on
their own. Replaces the two `router.refresh()` calls at lines 409 and 445.

**4c. `src/app/(app)/caja/caja-view.tsx`**
Subscribe filtered to this kiosk's slug. The drawer total moves as sales happen. This is
the screen staff stare at all night, so it matters most.

**4d. `src/components/app/sidebar-manifest.tsx:84`**
Add the `business_id=eq.` filter the bookings list already uses, so an owner is not
refetching the manifest on every unrelated business's change.

**4e. Bookings list, incremental instead of full refetch**  (still open)
Today any event refetches the whole range. Apply the INSERT/UPDATE/DELETE payload to the
cached row instead, and only refetch when the payload is outside the loaded range. Left
for Phase 3, where the query cache makes it clean.

**What shipped**

- Migration `20260818120000_realtime_payments.sql`: publishes `stripe_transactions`,
  `stripe_refunds`, `cash_sales`, all at `REPLICA IDENTITY FULL`.
- Migration `20260818120100_realtime_bookings_deletes.sql`: `bookings` to
  `REPLICA IDENTITY FULL`. This fixed a bug nobody had reported. The bookings list
  subscribes with `business_id=eq.<id>` for everyone except the owner, and at the
  default replica identity a DELETE carries only the primary key, so the filter could
  not match it. Managers and check-in staff never saw a booking deleted on another
  desk. Owners did, because they subscribe unfiltered, which is why it stayed hidden.
- `src/lib/realtime/use-live-refresh.ts`: shared hook. Subscribes to the tables you
  name, debounces (one sale can land as a charge, a balance transaction and a refund),
  defers while the tab is hidden and catches up on return, and logs a dead subscription
  to the console. A silently dead subscription is the worst failure mode here, since the
  screen looks live and is not.
- `/admin/payments` and `/caja` now use it. `/caja` filters to its own kiosk
  (`cash_sales.kiosk_slug`, `stripe_transactions.source`) and only subscribes when the
  day being viewed is today.
- `sidebar-manifest.tsx` gained the `business_id` filter the bookings list already had,
  threaded through `app-shell` / `app-topbar` / `mobile-nav`.

**Verified end to end** on `/admin/payments`, driving the database from a separate
process while watching the open page:

| Event | Result |
|---|---|
| INSERT a cash sale | row appears, Cash total 18,357 to 18,480, count 251 to 252 |
| UPDATE it to refunded | Refunded total 414 to 538, row flips to Refunded |
| DELETE it | row goes, totals back to 18,357 / 251 |

One `router.refresh()` per event, zero full page reloads, and the DB-aggregated summary
cards moved with the feed. The `/caja` filter strings were confirmed accepted by
Realtime (channel reaches SUBSCRIBED, not CHANNEL_ERROR); the screen itself was not
driven end to end because it requires a kiosk login.

Messages needed no work. It already subscribed to `sms_messages` INSERTs and patches its
own state, inbound and outbound.

### Phase 5. Paint before the data lands  (DONE)

Pages currently `await` everything before rendering anything.

Done for `dashboard/page.tsx` (three boundaries: today's counts, the tour tallies, the
month rollup) and `bookings/page.tsx` (header paints, the joined bookings read and the
tour variants stream, keyed by date so changing days shows a skeleton rather than
yesterday's rows). Siblings render concurrently, so splitting costs no parallelism.

`admin/payments/page.tsx` was left alone on purpose. Its header, summary cards and
filters all live inside the `PaymentsView` client component, so there is nothing the
page can paint early without splitting that component first. `loading.tsx` already
covers the wait. Worth doing if `PaymentsView` is ever broken up for another reason.

Sidebar links now prefetch on hover (`app-sidebar.tsx`). Viewport prefetch was the wrong
tool: these routes are dynamic, so Next only prefetches the loading skeleton, and asking
for the real payload on all fourteen links would render fourteen pages every time the
sidebar mounts.

**Verified against a production build**, because `router.prefetch()` is a deliberate
no-op in development (`next/dist/client/components/app-router.js`: "Don't prefetch during
development"). Hovering Analytics fetched it once with no click; the click then navigated
with zero further network.

### Phase 6. Infrastructure check  (DONE: there is a mismatch, decision pending)

They do not match.

| | Region |
|---|---|
| Vercel functions | `iad1`, Washington DC (confirmed from the `x-vercel-id` header on primewillcall.vercel.app) |
| Supabase project | `us-west-2`, Oregon |
| The business and its staff | Miami |

So every database query crosses the continent and back, roughly 60 to 70ms, and a page
makes several. Three options:

1. **Pin the functions to `pdx1`** (Portland, next to the database). One `vercel.json`.
   Queries drop to a couple of ms; the browser hop from Miami gets ~50ms longer, but that
   is paid once per request while the query cost is paid per query. Reversible in a line.
2. **Move the Supabase project to `us-east-1`** and leave Vercel in `iad1`. The best
   end state: close to the database *and* close to the staff. It is a project migration
   (new project, restore, re-point keys, webhooks and edge functions), so it is real work
   with real risk. It is also far cheaper now, before go-live, than after.
3. **Leave it.** Defensible only if 2 is planned for cutover anyway.

This is a call for the platform owner, not a code change, so nothing was done.

---

## Expected result

| | Now | After |
|---|---|---|
| Repeat visit to a screen | full re-render, 2 auth calls + queries | from cache, instant |
| First visit | 2 auth calls + queries, then paint | 0 auth calls, streams in |
| New sale on another desk | invisible until reload | appears live |
| Caja drawer total | stale until reload | moves as it sells |

---

## Order to build

1. Phase 1 + Phase 2. Small, no risk, immediately noticeable.
2. Phase 4a + 4b + 4c. Fixes the realtime regression on money screens.
3. Phase 3. The cache layer, and it makes 4d/4e clean.
4. Phase 5, Phase 6, then Phase 1b if still worth it.
