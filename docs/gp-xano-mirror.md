# Temporary: mirroring `/gp` bookings into Xano

**This is scaffolding for one experiment. Delete it when the experiment ends.**

## Why

`/gp` is the test bed for the Supabase messaging automations. Supabase creates
the booking and sends the SMS. Xano still needs a copy, so that a failure in the
new stack does not leave staff with a guest who booked and no record on the side
they actually work from.

## How the guest avoids being texted twice

1. **No phone on the Xano row.** Xano's booking SMS trigger reads the phone off
   the booking. `booking/v12` maps the literal string `"null"` to a null phone,
   so the trigger has nowhere to send. Confirmed with the owner that it stops
   there and does not fall back to the linked contact record.
2. **`trigger: false`** on the mirrored row, a second brake in case a campaign
   trigger keys off that flag rather than the phone.

## How the booking avoids coming back as a duplicate

Xano's "New Supabase platfomr" trigger pushes every `bookings` row into Supabase
through `xano-booking-sync`. We pick the reference (`GP-<16 hex>`) and stamp it on
our own booking twice: as `legacy_id` (`ota-GP-<ref>`, the sync's dedup key) and as
`xano_internal_id` (the key the general mirror matches Xano's echo on, see
[`xano-mirror.md`](xano-mirror.md)). The sync finds the row by `xano_internal_id`,
sees it was born here, and applies only the iPad check-in and Peek from the echo.
A later edit of a Groupon booking made in this app goes back to Xano through the
general mirror, addressed by that same internal id.

## The ordering that matters

`legacy_id` is set in a separate UPDATE immediately after the insert, never in
the insert itself:

```
insert booking (legacy_id NULL)   -> trg_native_booking_automations fires, SMS enqueued
update booking set legacy_id      -> sync-back now has something to match
POST Xano booking/v12             -> Xano's trigger pushes the row back, upsert hits our row
```

`trg_native_booking_automations` is `AFTER INSERT ... WHEN (new.legacy_id IS
NULL)`. Setting `legacy_id` inline would mark the booking as Xano-synced and
**silence the very SMS the test exists to exercise**. The later UPDATE is still
safe, because Xano cannot push the row back before we have called it.

## Config

| Variable | Meaning |
| --- | --- |
| `GP_XANO_MIRROR` | `"true"` enables the mirror. Anything else disables it. |
| `XANO_API_TOKEN` | Xano API token, auth group 57. `booking/v12` requires it. |

Both are read by the `gp-book` edge function, so they are Supabase function secrets.
Vercel no longer needs either one. The HTTP call itself lives in
`_shared/xano-api.ts` (`xanoCreateBooking`), shared with the general mirror.

A mirror failure never fails the guest's booking: it is logged as
`[gp] Xano mirror failed ...` and the Supabase row stands, since that is the
source of truth for the test.

## Removing it

1. Set `GP_XANO_MIRROR=` (or drop it) in `.env.local` and Vercel. That alone
   stops all Xano writes.
2. Delete `supabase/functions/_shared/gp-xano-mirror.ts` and its calls in
   `gp-book` and `stripe-webhook`. The general mirror (`xano-mirror.md`) would then
   need to take over Groupon creation, or be retired with it.
3. Drop `GP_XANO_MIRROR` and `XANO_API_TOKEN` from `.env.example`.
4. Delete this file.

Bookings already mirrored keep their `legacy_id`. Leave it: it is what stops the
Xano copy from ever being re-imported as a duplicate.
