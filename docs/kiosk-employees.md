# Kiosk employees and the PIN

Every tablet action is attributed to a person. The tablet login (`kiosks.slug`) says
which iPad; the employee PIN says who.

## How it works

- **People.** `kiosk_employees`: name, active flag, and a 4-digit PIN stored as a salted
  SHA-256 (`sha256(salt:pin)`, identical code in `supabase/functions/_shared/kiosk-pin.ts`,
  `src/lib/kiosk/pin.ts` and the tablet). Employees are **one pool shared by every
  business**: the businesses sit next to each other and people cover for each other, so
  by the owner's choice there is no "works at" and any employee may unlock any tablet.
  PINs are unique across the pool (the `kiosk_pin_in_use` definer function checks), so a
  PIN alone identifies the person on every tablet.
- **The tablet.** When `kiosks.pin_required` is on, the app shows a keypad over everything
  until a valid PIN is typed. The check is **local and immediate**: `kiosk-config` carries
  the kiosk's eligible employees (id, name, salted hash, never the PIN), the tablet hashes
  the typed PIN the same way (`js-sha256`) and unlocks on a match, then asks
  `kiosk-pin-verify` in the background, which records the sign-in (`pin_ok`, `last_seen_at`)
  and, if that PIN was changed or removed since the list was cached, answers `bad_pin` and
  the tablet locks again. A PIN the tablet does not know (someone added since the last
  config fetch) goes to the server first and the list is refreshed after. The list is
  refreshed at launch, on every return to the foreground and after any server-checked PIN.
  The hashes sit on the tablet because a PIN is attribution on a trusted device, not a
  secret guarding money. The person stays unlocked until they
  tap their name at the top of the screen (Lock). There is no idle timer and no lock when
  the app goes to the background: the owner tried both on a tablet and does not want a
  keypad appearing mid-sale (`kiosks.pin_idle_lock_seconds` is kept but unused). A small
  pill with the first name is the only thing added to the screens.
- **Attribution.** Every event the tablet logs (`kiosk_events.employee_id / employee_name`)
  and every write it makes carries the employee: `cash_sales.employee_id`,
  `kiosk_sales.employee_id`, `bookings.kiosk_employee_id`. Check-ins are recorded as
  `check_in` / `check_in_undo` events with the booking reference.
- **Wrong PINs** never lock anyone out (owner's choice); each attempt is an event
  (`pin_failed`), so a run of them is visible on the Employees page.
- **Old builds** never call `kiosk-pin-verify` or read `pin_required`; nothing changes for
  them. Builds 9+ support it.

## The admin page: Team

Three tabs (Accounts, People, Activity; Team opens on Accounts for the owner, on People
for a manager), the model a new owner learns in one sentence: a **person** works here and
types a PIN; an **account** is a login.

- **People** (`/admin/staff/people`, owner and any business manager): the employees who type a
  PIN, one pool for every business. A card per person with Active / Inactive, when the
  PIN was last used and where (a tablet, or the web), and Activity (opens the log
  filtered to them), Change PIN, Deactivate / Reactivate, Remove (past activity keeps
  the name). **Add employee** is a small dialog: name, PIN, confirm. Nothing else on
  the tab, by the owner's choice: no intro text, no always-open form.
- **Activity** (`/admin/staff/activity`, owner and manager): the log, described below.
  Its Person filter lists the people (by PIN) and the accounts (by login) under two
  headings.
- **Accounts** (`/admin/staff/accounts`, owner): every login, grouped by business with
  the role badge, exactly the team list as it always looked. A check-in account is a
  shared desk or tablet; its **Shared computer** switch on the edit page sets
  `staff.pin_required` (the desk computer) and `kiosks.pin_required` (its tablet, by
  `staff.kiosk_slug`) together. **Add account** opens the team member form in a dialog,
  the same way People adds an employee (`components/ui/dialog.tsx`).

`kiosk_employees.staff_id` exists (a person's own login) but the screens do not use it
yet: the owner asked for people and logins to stay two plain lists.

**Activity**, built for volume:

- Reads go through the `activity_feed` RPC (tablets and web as one stream, filters +
  keyset paging on `at, key`, 100 rows a page, "Load more" continues from the last row);
  SECURITY INVOKER, so `kiosk_events` and `audit_log` RLS still scope it. A busy day
  never comes into memory, and page 40 costs what page 1 does.
- Filters, all in the URL: one day (a single calendar, today by default; the RPC
  takes a range, the page just asks for one day), employee, tablet, **action group** (`EVENT_GROUPS` in
  `src/lib/kiosk/events.ts`: sales, guests and bookings, sign-ins, card reader,
  tablet housekeeping; each maps to exact event names so the filter is an index
  lookup). Picking a value applies it (no Show button). Tablet housekeeping
  (`level = 'debug'`: foreground, background, settings checks) shows only when that
  group is picked; that is what keeps the default view readable. The RPC also takes
  a problems-only switch (warn + error) and a search (ref, name, payload text) that
  the page does not expose, by the owner's choice; a partial index covers the
  problems view for the day it is wanted.
- Live: while the range includes now, the client (`activity-feed.tsx`) holds one
  Realtime INSERT subscription on `kiosk_events` and prepends rows that pass the same
  filter, so a new action shows within a second without re-rendering the page.
  (The earlier `useLiveRefresh` approach re-ran every query on every event, which a
  busy tablet would turn into a refresh a second.)
- Each person's card has an **Activity** link that filters the log to them, by both
  their PIN and their login (`personValue()` in `activity-shared.ts`).

Labels and groups live in `src/lib/kiosk/events.ts`; a new event from the tablet needs
a label and a group there.

## What the tablet records

Sign in / wrong PIN / lock / sign out; check-in and undo; booking created; ticket QR
scanned; receipt printed; sale opened from the sales list; cash sale recorded; the
whole card sale story (details entered, started, card read, result, retry, cancelled,
paid, completed, reused, expired, blocked on low battery); reader connected, dropped,
reconnecting, disconnected by staff, battery; and the housekeeping (app opened,
foreground, background, settings check). Every row carries the tablet, the app build
and, when someone is signed in, the employee.

## The web app

The same log covers the web app, without a log call in any screen:

- **`audit_log`** is written by one generic trigger, `log_staff_change()`, attached to
  every table staff edit from the web (bookings, customers, cash sales, refunds, closed
  times, tours, prices, businesses, team, employees, message rules, tablets). One row per
  created / updated / deleted row: the staff login, the business, the table and row,
  which columns changed and a before/after diff (`payload.diff`; the full row for a
  create or delete, minus secrets), plus the guest's name on a booking. It fires only
  for a real staff session (`auth.uid()` set): the Xano sync, Stripe webhooks, the kiosk
  functions and cron run as the system and are not staff actions. The `payments`
  function writes as the system on a staffer's behalf, so it records its refunds and
  sale moves itself (`_shared/audit.ts`).
- **Shared logins.** `staff.pin_required` (owner-set, "Shared computer" on
  `/admin/staff/[id]`) marks a login several people use on one computer. The web then
  shows the keypad (`components/app/web-pin-lock.tsx`) until someone types their PIN,
  the same PIN as on the tablets (`web_employee_unlock`), and shows their name with a
  Lock chip in the top bar. Who they are lives in two cookies until Lock
  (`lib/employee-session.ts`): a signed httpOnly one the server trusts, and a plain id
  the browser Supabase client reads to send `x-employee-id` on every request. The
  trigger reads that header (`request_employee()`), so a direct edit from the bookings
  page is attributed the same way a server action is. Personal logins never see the
  keypad; their actions are logged under the account.
- **One feed.** `activity_feed()` unions `kiosk_events` and `audit_log` with one set of
  filters (day, where: tablets / web, person: employee or web login, tablet, action
  group) and keyset paging on `(at, key)`. Web rows are named `entity.action`
  (`bookings.updated`) and the page turns the diff into words in
  `src/lib/kiosk/events.ts` (`checked_in_at` set means "Checked a guest in").

## Switch

```sql
update kiosks set pin_required = true  where slug = 'kiosk1';   -- on
update kiosks set pin_required = false where slug = 'kiosk1';   -- off
```

The tablet re-reads it at launch and on every return to the foreground (and the lock
screen re-checks every few seconds), so no reinstall.

## Pieces

| Where | What |
|---|---|
| `supabase/migrations/20260907181427_kiosk_employees_pin.sql` | table, switch, attribution columns, RLS |
| `supabase/functions/kiosk-pin-verify` | the server-side PIN check; records the sign-in |
| `supabase/functions/kiosk-config` | carries the employee list (hashes) for the local check |
| `kiosk-sale-start`, `kiosk-sale-complete`, `kiosk-log`, `kiosk-cash-sale`, `kiosk-booking` | accept `employee_id` |
| `supabase/migrations/20260907192526_kiosk_activity_feed.sql` | tablet-only feed RPCs (since replaced), partial indexes |
| `supabase/migrations/20260907195532_web_activity_log.sql` | `audit_log` trigger, `staff.pin_required`, web PIN functions, `activity_feed` |
| `src/lib/employee-session.ts`, `src/app/(app)/employee-actions.ts`, `components/app/web-pin-lock.tsx`, `employee-chip.tsx` | the web PIN |
| `supabase/functions/_shared/audit.ts` | explicit log rows from service-role functions (`payments`) |
| `src/app/(app)/admin/staff/(tabs)/*`, `src/lib/kiosk/pin.ts`, `src/lib/kiosk/events.ts` | Team: People (`people-view.tsx`), Accounts, the log (`activity-feed.tsx`) |
| PrimeKiosk `src/services/EmployeeSession.ts`, `src/context/EmployeeSessionContext.tsx` | session, keypad, pill |
