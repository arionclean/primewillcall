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
through `xano-booking-sync`, which upserts on `legacy_id`, derived as
`ota-<booking_reference>`. We pick the reference (`GP-<16 hex>`) and stamp the
matching `legacy_id` on our own booking, so the round trip **updates the booking
we already created** rather than inserting a second one.

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

Both are read by `/api/gp/book`, a Next.js route, so they belong in `.env.local`
and in the Vercel project env. They are NOT Supabase function secrets.

A mirror failure never fails the guest's booking: it is logged as
`[gp] Xano mirror failed ...` and the Supabase row stands, since that is the
source of truth for the test.

## Removing it

1. Set `GP_XANO_MIRROR=` (or drop it) in `.env.local` and Vercel. That alone
   stops all Xano writes.
2. Delete `src/lib/xano/gp-mirror.ts` and its block in
   `src/app/api/gp/book/route.ts` (the import, `mirrorRef`, the `legacy_id`
   update, the mirror call).
3. Drop `GP_XANO_MIRROR` and `XANO_API_TOKEN` from `.env.example`.
4. Delete this file.

Bookings already mirrored keep their `legacy_id`. Leave it: it is what stops the
Xano copy from ever being re-imported as a duplicate.
