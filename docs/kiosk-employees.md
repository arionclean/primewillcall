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

## The admin page

`/admin/employees` (owner and any business manager manage the shared pool; check-in
accounts are redirected away):
add an employee (name, PIN), change a PIN, deactivate or reactivate, remove (past
activity keeps the name), and **Activity**, built for volume:

- Reads go through the `kiosk_activity` RPC (filters + keyset paging on `at, id`,
  100 rows a page, "Load more" continues from the last row) and `kiosk_activity_count`
  for the total; both are SECURITY INVOKER so `kiosk_events` RLS still scopes them.
  A busy day never comes into memory, and page 40 costs what page 1 does.
- Filters, all in the URL: date range with presets (today, yesterday, 7 and 30
  days), employee, tablet, **action group** (`EVENT_GROUPS` in
  `src/lib/kiosk/events.ts`: sales, guests and bookings, sign-ins, card reader,
  tablet housekeeping; each maps to exact event names so the filter is an index
  lookup), problems only (warn + error), search (code, name, amount, anything in
  the payload). Tablet housekeeping (`level = 'debug'`: foreground, background,
  settings checks) is hidden unless asked for; that is what keeps the default view
  readable. Partial indexes cover the default and the problems view.
- Live: while the range includes now, the client (`activity-feed.tsx`) holds one
  Realtime INSERT subscription on `kiosk_events` and prepends rows that pass the same
  filter, so a new action shows within a second without re-rendering the page.
  (The earlier `useLiveRefresh` approach re-ran every query on every event, which a
  busy tablet would turn into a refresh a second.)
- Each person's card has an **Activity** link that filters the log to them.

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
| `supabase/migrations/20260907192526_kiosk_activity_feed.sql` | `kiosk_activity` + `kiosk_activity_count` RPCs, partial indexes |
| `src/app/(app)/admin/employees/*`, `src/lib/kiosk/pin.ts`, `src/lib/kiosk/events.ts` | the admin page (`activity-feed.tsx` is the log) |
| PrimeKiosk `src/services/EmployeeSession.ts`, `src/context/EmployeeSessionContext.tsx` | session, keypad, pill |
