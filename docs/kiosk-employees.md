# Kiosk employees and the PIN

Every tablet action is attributed to a person. The tablet login (`kiosks.slug`) says
which iPad; the employee PIN says who.

## How it works

- **People.** `kiosk_employees`: name, business, active flag, and a 4-digit PIN stored as a
  salted SHA-256 (`sha256(salt:business_id:pin)`, identical code in
  `supabase/functions/_shared/kiosk-pin.ts` and `src/lib/kiosk/pin.ts`). PINs are unique
  among the active employees of a business, so a PIN alone identifies the person on that
  business's tablets.
- **The tablet.** When `kiosks.pin_required` is on, the app shows a keypad over everything
  until a valid PIN is typed (`kiosk-pin-verify`). The person stays unlocked until they
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

`/admin/employees` (owner and business manager; a manager sees only their business):
add an employee (name, business, PIN), change a PIN, deactivate or reactivate, remove
(past activity keeps the name), the PIN on/off state of each tablet (read-only, flipped
by SQL on request), and **Activity**: every event of a day, filterable by person and
tablet, live. Labels live in `src/lib/kiosk/events.ts`.

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
| `supabase/functions/kiosk-pin-verify` | the PIN check + rate limit |
| `kiosk-config`, `kiosk-sale-start`, `kiosk-sale-complete`, `kiosk-log`, `kiosk-cash-sale`, `kiosk-booking` | accept `employee_id` |
| `src/app/(app)/admin/employees/*`, `src/lib/kiosk/pin.ts`, `src/lib/kiosk/events.ts` | the admin page |
| PrimeKiosk `src/services/EmployeeSession.ts`, `src/context/EmployeeSessionContext.tsx` | session, keypad, pill |
