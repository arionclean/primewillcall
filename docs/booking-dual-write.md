# Booking dual-write and dedup (Xano to Supabase migration)

How to move booking *writes* from Xano to Supabase without a big-bang cutover and
without creating duplicate bookings. Applies to the kiosk (PrimeKiosk) and any other
writer (OTA connector, widget, `/gp`). Companion to the payment migration (kiosk POS
edge functions) and the `xano-booking-sync` edge function.

## The problem

During the parallel phase, two paths can write the same booking into Supabase:

1. The **app**, writing directly to Supabase (the new path we want to test early).
2. The **`xano-booking-sync`** edge function, which mirrors every Xano booking into
   Supabase.

If both do a blind `insert`, Supabase gets the booking **twice**.

## The rule (two lines)

- **Every parallel write is an `upsert` on a shared key**, so retries and a second
  writer converge onto the same row instead of duplicating.
- **Only one writer is "primary" at a time**, chosen by a runtime flag. The other path
  is either idempotent (shadow) or off.

## The dedup key

- **Booking key = the Xano booking id**, stored in `bookings.legacy_id`
  (UNIQUE index `bookings_legacy_id_key`, already present). It is the upsert conflict
  target for BOTH the app write and the sync.
- **Where it comes from:** Xano assigns it on create. In the parallel phase the app
  creates the Xano booking first, reads that id from the response, and writes it as
  `legacy_id` in its Supabase write. The sync writes the same value. Same key -> one row.
- The key lives **in the data** (a correlation id on the row), not in config. It is not
  the same thing as the writer-mode flag (that lives in remote config, see below).
- **Customer key (implemented):** a booking creates a customer too, so customers can
  duplicate the same way. There is no Xano customer id to key on, and ~1000 duplicate
  customer groups already exist, so a strict unique index is not free. Instead
  `customers.dedup_key` holds a deterministic
  `business_id:norm(full_name):norm(phone)` (norm = lowercase + strip non-alphanumeric,
  matching the sync), with a PARTIAL unique index (`where dedup_key is not null`). The 78k
  legacy rows stay null and untouched; new writers set dedup_key and upsert on it. Both the
  sync and the app must compute the SAME key.

## The writer-mode flag

A single remote value the app reads at runtime (see the app kill-switch design):

- `xano` — app writes the booking to **Xano only**; the sync mirrors it into Supabase.
  (Today's behavior.)
- `dual` — app writes to **Xano (primary)** and **shadow-upserts** the same booking into
  Supabase with `legacy_id = xano.id`. The sync stays on but is idempotent on that key,
  so the row never duplicates. This is the safe test mode.
- `supabase` — app writes to **Supabase first** (its own uuid, `legacy_id` null) and the
  **sync is turned off**. This is the cutover.

The flag lives on the stable side (Xano or a static config), defaults to `xano`, and is
read at runtime so you can flip it (or flip back) with no app release. Never run
Supabase-primary writes and the sync at the same time.

## Phases

**Phase 1 - parallel / shadow (test now, zero risk):** flag `dual`.
Xano stays the source of truth. The app exercises the full Supabase write path (field
mapping, customer creation, RLS, insert) on live traffic, but every write is an upsert on
`legacy_id`, so it converges with the sync. You debug calmly; staff see nothing.

**Phase 2 - cutover (Xano off):** flag `supabase`.
The app writes Supabase first with its own uuid; the sync is disabled. The only code
difference from Phase 1 is the id source and dropping the Xano write, so the risky logic
was already proven in Phase 1.

## App write (pseudocode)

Phase 1 (`dual` / shadow):

```
const xano = await createXanoBooking(...)      // primary; returns xano.id
await supabase.from("bookings").upsert(
  { legacy_id: xano.id, ...mapFields(...) },
  { onConflict: "legacy_id" },                 // never a plain insert
)
// customer: upsert on the customer dedup key, not a blind insert
```

Phase 2 (`supabase` primary):

```
const b = await supabase.from("bookings").insert({ ...fields }).select().single()
// no Xano write; sync disabled for this mode
```

## Rollback

- Any issue in Phase 1: the shadow write is non-authoritative and idempotent. Flip the
  flag back to `xano`; Xano is untouched, and Supabase rows can be ignored or deleted.
- Because the shared key + upsert guarantees convergence, a retried or double-fired write
  can never create a second booking.

## Checklist before dual-writing bookings

- [x] `bookings.legacy_id` has a unique index (`bookings_legacy_id_key`).
- [x] Add a **customer** dedup key: `customers.dedup_key` + partial unique index
      (`20260715120000_customer_dedup_key.sql`).
- [ ] Make the **sync** compute + upsert customers on `dedup_key` (today it blind-inserts).
- [ ] Make the **app** dual-write compute the SAME `dedup_key` and upsert on it.
- [ ] App reads the Xano booking id and passes it as `legacy_id`.
- [ ] All Supabase booking/customer writes use `upsert` (never plain `insert`) in `dual`
      mode.
- [ ] Writer-mode flag added, defaults to `xano`, flips to `dual` then `supabase`.
- [ ] In `supabase` mode the `xano-booking-sync` path is disabled (no double writer).
