# Database

Supabase project `qbnizuhozzwkiitfkjee`, schema `public`. The migrations under
`supabase/migrations/` are the source of truth; this file is the human-readable map.
Regenerate types after any schema change into `src/lib/supabase/database.types.ts`.

## Entity model

```
businesses ─┐
            ├─< business_tours >─ tours ─< tour_timeslots
            │        │
            │        └─< tour_pax_tiers
            ├─< customers
            ├─< staff ─< staff_tours >─ tours
            └─< bookings >─ business_tours
                     │
                     └─ customers
```

- A `tour` is a Prime-owned master: capacity, timeslots, meeting point, instructions.
- A `business_tour` is one business's copy of a master tour (its own display `name` and
  `is_active`). Unique on `(tour_id, business_id)`.
- `tour_pax_tiers` hold pricing per `business_tour` (adult / child / infant, `price_cents`).
- `tour_timeslots` belong to the master `tour` and are shared by every business copy.
- A `booking` references one `business_tour` and one `customer`, stores `pax_adult/child/infant`,
  a `tour_pax_breakdown` jsonb snapshot, and `total_cents`.

## Tables

### businesses
`id uuid pk, name, slug, address?, phone?, timezone, logo_url?, created_at, updated_at`
One row per business Prime operates. Logos live in the `business-logos` storage bucket.

### staff
`id uuid pk, user_id? (-> auth.users), business_id? (-> businesses), role enum,
full_name, email, phone?, is_active, created_at, updated_at`
Role enum (`staff_role`): `owner`, `business_manager`, `check_in`. `owner` has no
`business_id`. A trigger links a new `auth.users` row to its `staff` row by email.

### tours (master, Prime-owned)
`id uuid pk, name, kind, capacity, notes?, instructions?, meeting_point_address?,
meeting_point_lat?, meeting_point_lng?, is_active, created_at, updated_at`

### tour_timeslots
`id uuid pk, tour_id (-> tours), start_time time, duration_minutes, sort_order,
is_active, created_at, updated_at` — unique `(tour_id, start_time)`.

### business_tours (a business's copy of a tour)
`id uuid pk, tour_id (-> tours), business_id (-> businesses), name, is_active,
created_at, updated_at` — unique `(tour_id, business_id)`.

### tour_pax_tiers (pricing)
`id uuid pk, business_tour_id (-> business_tours), label, description?, price_cents,
currency, sort_order, is_active, created_at, updated_at`

### customers
`id uuid pk, business_id (-> businesses), full_name, email?, phone?,
stripe_customer_id?, notes?, created_at, updated_at`

### bookings
`id uuid pk, business_id, business_tour_id, customer_id, starts_at, ends_at,
status enum, total_cents, currency, pax_adult, pax_child, pax_infant,
tour_pax_breakdown jsonb, notes?, stripe_payment_intent_id?, created_by_staff_id?,
checked_in_at?, checked_in_by_staff_id?, created_at, updated_at`
`status` is the payment lifecycle the app exposes: `confirmed` (normal, shown with
no tag), `pending` (shown as "Waiting for payment"), and `cancelled`. Bookings created
from `/schedule` start as `confirmed`. The enum (`booking_status`) also contains the
legacy values `checked_in` and `completed`; the app no longer writes them. Check-in is
tracked independently of status via `checked_in_at` (set/cleared by the check-in
toggle and the check-in API), so a guest can be checked in regardless of payment status.

### staff_tours
`staff_id, tour_id, created_at` — which tours a `check_in` staffer is assigned to.

### audit_log
`id bigint pk, occurred_at, actor_staff_id?, actor_kiosk_id?, entity, entity_id?,
action, payload jsonb` — append-only audit trail.

### Legacy / unused
`kiosks` and `kiosk_tours` remain from the original schema but nothing in the app reads
them. Slated for removal once confirmed dead. Do not build on them.

## Access control (RLS)

RLS is enabled on all app tables. Every policy is expressed through the
`current_staff()` SECURITY DEFINER function, which returns the caller's
`(staff_id, role, business_id)`. This avoids recursive policy lookups on `staff`.

General shape:

- **owner**: full access to everything.
- **business_manager**: read + write rows belonging to their `business_id`
  (`bookings`, `customers`, `business_tours`, `tour_pax_tiers` via the parent business).
- **check_in**: read `business_tours` / `tour_pax_tiers` for their business; read +
  update `bookings` only for tours they are assigned to via `staff_tours`. Can insert
  `customers` for their business. Cannot delete bookings.

Table-specific notes:

- `tours` / `tour_timeslots`: all roles can read; only `owner` can write. (Timeslots are
  shared, so managers never edit schedules.)
- `customers`: owner + manager + check-in of the business can insert and read; update is
  owner + manager; delete is owner only.
- `bookings`: insert/delete is owner + manager (by business); check-in can read + update
  (check guests in) for assigned tours only.
- `business_tours` / `tour_pax_tiers`: owner full; manager read + write for their
  business; check-in read only.

When something returns no rows or a write silently fails, it is almost always RLS.
Verify the caller's role/business with `/dashboard/debug` and compare against the policy.

## Conventions

- UUID primary keys (`gen_random_uuid()`); `bigint identity` only for `audit_log`.
- Timestamps are `timestamptz`; `created_at` / `updated_at` on every table.
- Money is integer `*_cents`; never floats.
- Business operating timezone is `America/New_York` (see `businesses.timezone`).
