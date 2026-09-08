# The Xano mirror: booking changes made here are copied into Xano

Staff are moving to this app while the iPads still read Xano and Xano is still the
rollback path. So every booking created, edited, checked in or voided **here** is
copied into Xano, within about a minute, without the two systems ever going in
circles. The other direction (Xano into Supabase) is the older `xano-booking-sync`
webhook and is unchanged.

Migration: `20260908100000_xano_mirror.sql`. Worker: `supabase/functions/xano-mirror-dispatch`.
Pure logic + tests: `_shared/xano-mirror.ts`, `_shared/xano-mirror.test.ts`. Xano
HTTP: `_shared/xano-api.ts`.

## In one picture

```
staff edits a booking here
  -> AFTER trigger enqueue_xano_mirror writes ONE pending row per booking
     into xano_mirror_queue (the outbox). No Xano call inside the transaction.
  -> every minute pg_cron runs xano-mirror-dispatch, which claims due rows,
     reads the booking's CURRENT state and sends it:
        create -> POST booking/v12 (full record, add-or-edit by internal id)
        update -> PATCH booking/{id} (only the changed fields)
  -> Xano's "New Supabase platfomr" trigger echoes the row to xano-booking-sync
  -> the sync recognises the echo (bookings.xano_internal_id) and, for a booking
     born here, applies only the iPad check-in and Peek. Its own writes carry
     x-sync-origin: xano, so the trigger enqueues nothing for them. Loop closed.
```

## What is mirrored

| Change here | Xano gets | How |
| --- | --- | --- |
| New booking from `/schedule` | a new row: product, company, name, pax, time, status, note, our public token as `bookingConfirmation_id`, **no phone, no email** | `booking/v12` |
| Time, product, pax, status, note, check-in / un-check | only those fields | `PATCH booking/{id}` |
| Void / restore | status `canceled` / back to its status | same PATCH |

Not mirrored, on purpose: the guest's phone and email (see "No double SMS"),
customer edits, amount due, voucher codes, the kiosk employee, extra voucher photos,
prices. Xano has no place for them or must not have them.

Who creates what in Xano:

- **Born here on `/schedule`**: this mirror.
- **Groupon (`/gp`)**: `gp-xano-mirror.ts`, after payment (it must run after the
  confirmation SMS). It stamps `xano_internal_id`, so later edits go through this mirror.
- **Kiosk sales**: the kiosk sale flow posts its own Xano booking. Its writes carry
  `x-sync-origin: mirror`, so they are never queued. A staff edit of a kiosk booking
  from the web still is.
- **Born in Xano** (OTA emails, the widget, Bubble): Xano. Edits made here go back
  as a PATCH to that row.

## No double SMS

Each booking is texted by the system it was born in.

- Born in Xano: Xano texts on insert. The copy here carries a `legacy_id`, so
  `trg_native_booking_automations` stays quiet.
- Born here: this app texts on insert. The Xano copy has phone `"null"` (what
  `booking/v12` maps to a null phone), and Xano's SMS trigger (`City tour campaign_v1`)
  only fires `where phone != null`. Xano's contact trigger needs a phone or an email;
  it gets neither. The Make "b connector" and the older campaign trigger are off.
  `trigger: false` is a second brake. An update never texts on either side.
- An iPad check-in on a booking born here queues Xano's review ask, which has no
  phone to send to. This app's review funnel owns those bookings (`legacy_id` null).

The price: Xano cannot text, call or review-ask a guest booked here. Accepted.

## The loop, and the two brakes

1. **Origin.** Every write `xano-booking-sync` makes carries the request header
   `x-sync-origin: xano` (the ghost script sends it on its voids too). Code that
   mirrors on its own sends `x-sync-origin: mirror` (the kiosk sale flow, the worker's
   own stamps). PostgREST exposes request headers as `request.headers`;
   `xano_mirror_origin()` reads the one we care about and the trigger returns early.
   Direct SQL (a migration, cron) has no header and counts as an app write.
2. **Identity.** `bookings.xano_internal_id` is stamped BEFORE Xano is called
   (`SB-<16 hex>` for a booking born here; the `GP-` reference for Groupon; whatever
   Xano's row says for a Xano-born booking, learned from the echo). The sync looks it
   up first. A hit on a booking born here (legacy_id null or `ota-GP-`) takes only
   `checked_in_at` and `peek` from the echo, plus the Xano row id, and returns. The
   rest of the record (pax breakdown, end time, total, source label) is never
   touched, which is what the old blanket upsert would have broken.

   **What the echo actually carries.** Xano's trigger does not post the raw row: its
   function `new platform/sync booking to supabase_v1` sends a normalized record with
   no `internal_id`, no `id`, no `bookingConfirmation_id` and no `peek`. Its
   `unique_id` is Xano's unique_id when set, else the internal id; in Xano the two are
   equal (kiosk) or unique_id is empty, so the sync reads the internal id from
   `unique_id` when `internal_id` is absent. The first live test minted a twin before
   this was known. A full Xano record (the kiosk's dual-write posts Xano's response)
   still carries every field.

The "nothing changed" check is not a brake: an echo always differs in the fields
the sync reshapes. Identity is what protects the row.

### Stale echo

A check-in change of ours that is still queued (`fields` contains `checked_in_at`,
status pending or sending) beats the echo: the sync skips the echo's check-in
then. Everything else the worker sends is the booking's current state, so a burst
of edits collapses into one send and ordering cannot matter.

## The queue

`xano_mirror_queue`: `booking_id`, `op` (`create` / `update`), `fields` (which
mirrored fields changed, merged across edits), `status` (`pending`, `sending`,
`sent`, `failed`), `attempts`, `next_attempt_at`, `last_error`. One **pending** row
per booking (partial unique index): a new edit merges its fields into the existing
row. `claim_xano_mirror_rows(batch)` claims due rows with `FOR UPDATE SKIP LOCKED`
and puts a row stuck in `sending` for ten minutes back to pending.

Retries: a transient failure (Xano down, a 5xx) waits 1, 2, 4 ... minutes, capped at
an hour, and gives up after 12 attempts (about a day). A **terminal** failure is
marked `failed` at once, because retrying cannot help:

| `last_error` | Fix |
| --- | --- |
| The tour "X" is not linked to a Xano product. | Set `business_tours.legacy_product_id` (or the master `tours.legacy_product_id`; the mirror falls back to it). |
| The business "X" is not linked to a Xano company. | Set `businesses.legacy_company_id`. Today only "Miami Jet Ski Tours" lacks one. |
| Xano no longer has this booking. / Xano has no row for this booking. | Xano deleted it. The ghost script will void it here; nothing to do. |
| The booking no longer exists here. | Deleted here before the send. Nothing to do. |

Nothing in the app shows the queue (the owner asked not to see it). Read it by SQL:

```sql
select status, count(*) from public.xano_mirror_queue group by status;
select q.last_error, c.full_name, b.starts_at
  from public.xano_mirror_queue q
  join public.bookings b on b.id = q.booking_id
  join public.customers c on c.id = b.customer_id
 where q.status = 'failed' order by q.updated_at desc;
```

## Finding the Xano row for an update

In order: `bookings.xano_booking_id`; a `legacy_id` of the form `xano-<id>`; a GET
by internal id (`xano_internal_id`, or a `legacy_id` that is one, like a kiosk
`KS-` code); a GET by `bookingConfirmation_id` = our `public_token` (a booking that
arrived as a full Xano record carries Xano's confirmation id as its token; one that
arrived through the trigger echo does not, its token is one we generated). Whatever
is found is stamped on the booking, so the lookup happens once.

Going forward the sync stamps the internal id on every echo and the row id whenever
the payload has one. Bookings synced **before** this have neither and most cannot be
found by any lookup, so `scripts/stamp_xano_ids.py` fills them in once: it reads
Xano's public listing (read-only, the ghost script's read), matches each booking the
way the ghost script does, skips any key several Xano rows share, and with `--live`
writes the two ids through PostgREST with the `x-sync-origin: xano` header. Run it
before staff start editing Xano-born bookings here; until then such an edit fails
with "Xano has no row for this booking".

## The switch and the rollout

`xano_mirror_settings.enabled` (single row, default **false**). Off, the trigger
enqueues nothing and the worker sends nothing. Turn it on once the functions are
deployed:

```sql
update public.xano_mirror_settings set enabled = true, updated_at = now();
```

Secrets already in place: `XANO_API_TOKEN` (`booking/v12` needs it; the PATCH and
the GETs need none), `CRON_SECRET` / vault `dispatch_cron_secret` (pg_cron).

Rollback rule: never point staff back at Bubble while the queue has pending or
failed rows. Bookings born here are in Xano without a phone number.

## Gotchas

- **Never stamp `legacy_id` on a booking born here.** Every "is this ours" rule
  (the confirmation trigger, the review funnel, the ghost script) reads
  `legacy_id is null`. The mirror uses `xano_internal_id` precisely so those rules
  stay untouched. Groupon is the one prior exception (`ota-GP-`), and each rule
  already special-cases it.
- **`SB-` is the prefix this platform mints.** `PW-` is Xano's own (the email
  connector), `KS-` the kiosk, `GP-` Groupon. Do not reuse them.
- **The PATCH's `date_time` helper is avoided.** It rewrites Xano's `date` in a
  format Xano's own rows do not use, so a time change sends `date_timestamp` and
  `date` (`YYYY-MM-DD`) directly. Xano's day list filters on `date_timestamp`.
- **Status is spelled `canceled` in Xano** (4,000+ rows) and the sync accepts both.
- **A tour with no Xano product** cannot be mirrored. The Key West copies of the
  Miami tours have none of their own; the master tour's id is used, which is how
  Xano already models a Key West booking for a Miami product (its day list keys on
  the product regardless of company).
- **Two apps on one booking.** During the parallel run a business is on Bubble or on
  this app, not both. Two people editing the same booking from two systems is the
  one case the mirror cannot settle: last write wins, and the echo may flap once.

## Switching it off for good

When Xano is retired: set `enabled = false`, unschedule the `xano-mirror-dispatch`
cron job, and delete the function, `_shared/xano-mirror.ts`, `_shared/xano-api.ts`
(after `gp-xano-mirror.ts` goes), the trigger and the queue. Keep the two columns:
they are the record of where each booking lived.
