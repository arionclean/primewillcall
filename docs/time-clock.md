# The time clock

Desk staff clock in and out on the iPad they already use, with the PIN they already
type for sales. The owner reads the hours on Team.

Nothing here is a new idea about people: `kiosk_employees` is still one pool shared by
every business, still identified by a 4-digit PIN (`docs/kiosk-employees.md`). This
feature only adds the record of when they worked.

## On the tablet

A clock button (🕐) sits in the top bar of the main screen, on tablets whose kiosk has
the switch on. One button does both directions:

1. **PIN.** The same keypad as a sale, titled "Clock in or out".
2. **The server answers** who the PIN belongs to and whether they have a shift running.
   That question can only be answered centrally: the pool is shared, so somebody can
   clock in at one desk and out at another.
3. **Not on the clock** -> the front camera opens, "Smile, then tap Clock in". One tap
   takes the photo and opens the shift (the button stays grey until the camera is live).
   **On the clock** -> "On the clock since 9:02 AM", the hours so far, and one red
   Clock out button.
4. A short confirmation ("Clocked in at 9:02 AM", "Clocked out at 5:14 PM. 8h 12m
   today") that closes itself.

**The photo is required.** No photo, no clock in: the picture is what ties a shift to
the person who stood at the desk (the owner's call, 2026-09-18; the first version let a
missing camera through). So the screen deals with the camera instead of assuming it:

| The camera | What the person sees |
|---|---|
| Never asked on this iPad | iOS asks right there, once ("Allow" / "Don't Allow"), with the purpose line that mentions the clock-in photo |
| Refused, or switched off later | "Camera is off. Tap Open Settings, then turn on Camera." and an **Open Settings** button, which opens the app's own page in Settings. iOS restarts an app whose camera permission changed, so the person comes back to the main screen and taps the clock again (had it not restarted, the screen checks again by itself on the way back) |
| Blocked by Screen Time or device management | "Camera is blocked. Ask a manager to allow the camera on this iPad." Settings cannot fix that one, so there is no button |
| No camera at all (the simulator) | "No camera found. Ask a manager to check this iPad." |
| The shutter fails | "Could not take the photo. Try again." Nothing is recorded |

Each blocked case writes `clock_camera_off` to the activity log with the reason, under the
person who typed the PIN, and a failed shutter writes `clock_photo_failed`, so the owner
can see which iPad needs its camera fixed. The server holds the same line: `kiosk-clock`
answers a clock in without a photo with `photo_required`, and one whose photo will not
upload with `photo_upload_failed`, both before anything is written.

The simulator has no camera, so clocking IN can only be tried on a real iPad (clocking
out works anywhere). The photos go to a **private** bucket; only the owner can open one,
through a signed link that expires in an hour. Shifts without a picture (the test data
from before the rule) show the person's initial on the owner's screen.

**Online only, deliberately.** The open shift lives on the server, and another tablet
may hold it, so a punch queued on a tablet could not be reconciled honestly. A call
that fails says "No connection. Try again." and nothing is recorded. Everything else
the tablet does at that moment (sales, check-ins) already needs the network too.

**The PIN travels with every call.** The other kiosk functions accept an `employee_id`
the tablet claims, because a wrong one only mislabels a sale. A shift is a payroll
record, so `kiosk-clock` proves the person itself, against the live employee list.

## What the owner sees: Team -> Hours

Owner only (the tab, the page and the RLS policy all say so). The tab's pill is how
many people are on the clock right now, and the screen is live: a clock in or out
anywhere redraws it within a second (Realtime on `time_clock_shifts`). Whoever is
still working shows an "On the clock" badge and a running total in the table.

- **A range**: the same filter bar Analytics uses, a calendar for one day plus
  Today (the default), Yesterday, This week, Last week, This month, Last month and a
  custom From / To. Weeks start Monday.
- **Hours per person**: days worked, shifts, total. Summed in Postgres by the
  `time_clock_hours` RPC, never by adding rows up in the browser. Clicking a person
  opens their shifts underneath, each with the exact clock in and clock out times, the
  tablet, a thumbnail of the clock-in photo (tap it for the full size), the flags and
  the actions. That table is the whole screen: an earlier day-by-day list of every
  shift said the same things twice and the owner asked for it to go.
- **A banner for anything waiting on the owner**, counted across the whole record rather
  than the range on screen (the default view is today, and a clock out forgotten on
  Tuesday would otherwise never be in front of anyone). "Show them" widens the range to
  the oldest one.
- **Export CSV** for payroll: date, person, in, out, decimal hours, tablet, note.

The same hours feed **Per hour** on Team -> Sales: each person's tablet sales for the
range divided by the hours they clocked in it (see
[`kiosk-employees.md`](kiosk-employees.md)). The range bar is shared by the two tabs
(`range-bar.tsx`).

### Fixing things

- **Edit** sets the times of a shift (one date, two clock times; an end at or before the
  start means the next morning). Saving clears the review flag and stamps `edited_at`.
- **Looks right** accepts what the nightly job wrote, without changing the times.
- **Remove shift** deletes a punch that should never have happened.

Every one of those is an ordinary staff edit, so the `log_staff_change` trigger records
who did it and what changed, and it shows up on Team -> Activity like any other edit.

## The forgotten clock out

People forget. `time_clock_auto_close()` runs nightly (pg_cron, 08:00 UTC = 4 AM in New
York, after the last desk closes and before the first opens) and closes every shift left
open on an earlier New York day.

The end time it writes is **the last time that person typed their PIN that day**
(`kiosk_events.pin_ok`, which `kiosk-pin-verify` records for every PIN, whether it
opened a tablet or a sale), and failing that the clock-in time itself. So an
auto-closed shift reads short rather than long: the owner is never quietly overcharged
by a number nobody checked. It carries `auto_closed_at` until the owner confirms or
corrects it, and until then the screen flags it "Forgot to clock out".

A tablet with no per-sale PIN (kiosk4, bayride today) leaves no PIN trail, so a
forgotten clock out there closes at 0 hours and waits for the owner. That is the
trade: obviously wrong beats plausibly wrong.

## The switch

```sql
update kiosks set time_clock = true  where slug = 'kiosk1';   -- on
update kiosks set time_clock = false where slug = 'kiosk1';   -- off
```

`kiosk-config` carries it to the tablet (re-read at launch, on every return to the
foreground, and every few seconds while the main screen is open), and `kiosk-clock`
checks the same column on every call, so the switch is both the rollout and the
rollback. Builds before 23 never read the field; turning it on for their kiosk changes
nothing for them.

## Pieces

| Where | What |
|---|---|
| `supabase/migrations/20260917192342_time_clock.sql` | `time_clock_shifts`, `kiosks.time_clock`, the private bucket, `time_clock_hours()`, `time_clock_auto_close()` + its cron job |
| `supabase/functions/kiosk-clock` | the three ops (`status`, `in`, `out`); checks the PIN, uploads the photo, writes the shift |
| `supabase/functions/kiosk-config` | serves `time_clock` to the tablet |
| `supabase/functions/_shared/kiosk-pin.ts` | `matchPin()`, the PIN check shared with the web app's hashing |
| `src/app/(app)/admin/staff/(tabs)/hours/page.tsx` | the owner's screen (reads) |
| `src/app/(app)/admin/staff/(tabs)/hours-view.tsx` | the screen itself |
| `src/app/(app)/admin/staff/(tabs)/hours-actions.ts` | edit / confirm / remove |
| `src/app/(app)/admin/staff/(tabs)/hours-range.ts` | the ranges and the "8h 12m" wording |
| `src/lib/kiosk/events.ts` | `clock_in` / `clock_out` labels and the Time clock filter group |
| PrimeKiosk `src/components/TimeClockModal.tsx` | the tablet flow |
| PrimeKiosk `src/components/PinPad.tsx` | the keypad, now shared by the lock screen, the sale prompt and the clock |
| PrimeKiosk `src/config/backend.ts` | `clockStatus` / `clockIn` / `clockOut`, `getTimeClock()` |

## Not built (on purpose)

- **Breaks.** In and out only, by the owner's choice.
- **Pay rates and totals in money.** Hours only; payroll happens outside this platform.
- **Managers.** Owner only, everywhere.
- **Adding a shift by hand.** The owner can fix or remove what the tablets recorded, but
  a shift nobody clocked has to start from a punch. Worth adding if somebody forgets to
  clock in and out entirely.
- **A schedule.** This records what happened, not what was planned.
