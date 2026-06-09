-- Core schema for the new Master/Resources/Businesses model.
-- RLS policies live in a separate migration; this one only defines structure.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ──────────────────────────────────────────────────────────────────────────────
-- Enums
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TYPE public.staff_role     AS ENUM ('owner', 'business_manager', 'check_in');
CREATE TYPE public.booking_status AS ENUM ('pending', 'confirmed', 'checked_in', 'completed', 'cancelled');
CREATE TYPE public.kiosk_status   AS ENUM ('active', 'revoked');

-- ──────────────────────────────────────────────────────────────────────────────
-- updated_at helper (used by every table that has updated_at)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ──────────────────────────────────────────────────────────────────────────────
-- businesses
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.businesses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  address     text,
  phone       text,
  timezone    text NOT NULL DEFAULT 'America/New_York',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER businesses_set_updated_at BEFORE UPDATE ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ──────────────────────────────────────────────────────────────────────────────
-- staff (Prime employees; linked to auth.users by email at sign-in, or by user_id once linked)
-- One role per staff. business_id is NULL for owners (cross-business).
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.staff (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  business_id  uuid REFERENCES public.businesses(id) ON DELETE RESTRICT,
  role         public.staff_role NOT NULL,
  full_name    text NOT NULL,
  email        text NOT NULL UNIQUE,
  phone        text,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_role_scope_chk CHECK (
    (role = 'owner' AND business_id IS NULL) OR
    (role IN ('business_manager', 'check_in') AND business_id IS NOT NULL)
  )
);
CREATE INDEX staff_business_id_idx ON public.staff(business_id);
CREATE INDEX staff_role_idx        ON public.staff(role);
CREATE TRIGGER staff_set_updated_at BEFORE UPDATE ON public.staff
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ──────────────────────────────────────────────────────────────────────────────
-- resources (e.g. jet skis) — each belongs to exactly one business
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.resources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  name         text NOT NULL,
  kind         text NOT NULL,
  notes        text,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX resources_business_id_idx ON public.resources(business_id);
CREATE TRIGGER resources_set_updated_at BEFORE UPDATE ON public.resources
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ──────────────────────────────────────────────────────────────────────────────
-- resource_blocks — bookable hour blocks per resource (e.g. 1hr / 2hr)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.resource_blocks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id       uuid NOT NULL REFERENCES public.resources(id) ON DELETE CASCADE,
  label             text NOT NULL,
  duration_minutes  integer NOT NULL CHECK (duration_minutes > 0),
  price_cents       integer NOT NULL CHECK (price_cents >= 0),
  currency          text NOT NULL DEFAULT 'usd',
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX resource_blocks_resource_id_idx ON public.resource_blocks(resource_id);
CREATE TRIGGER resource_blocks_set_updated_at BEFORE UPDATE ON public.resource_blocks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ──────────────────────────────────────────────────────────────────────────────
-- staff_resources — check-in staff ↔ resources (only relevant when role = 'check_in')
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.staff_resources (
  staff_id     uuid NOT NULL REFERENCES public.staff(id)     ON DELETE CASCADE,
  resource_id  uuid NOT NULL REFERENCES public.resources(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, resource_id)
);
CREATE INDEX staff_resources_resource_id_idx ON public.staff_resources(resource_id);

-- ──────────────────────────────────────────────────────────────────────────────
-- customers — end-renters. Scoped per business (same person at two businesses = two rows).
-- Our DB is authoritative; stripe_customer_id is a reference.
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.customers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  full_name           text NOT NULL,
  email               text,
  phone               text,
  stripe_customer_id  text UNIQUE,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customers_business_id_idx ON public.customers(business_id);
CREATE UNIQUE INDEX customers_business_email_unique_idx
  ON public.customers(business_id, lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX customers_business_phone_unique_idx
  ON public.customers(business_id, phone)        WHERE phone IS NOT NULL;
CREATE TRIGGER customers_set_updated_at BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ──────────────────────────────────────────────────────────────────────────────
-- bookings — a customer renting a resource for a time window
-- business_id is denormalized for RLS performance (always = resource.business_id).
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.bookings (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id              uuid NOT NULL REFERENCES public.businesses(id)     ON DELETE RESTRICT,
  resource_id              uuid NOT NULL REFERENCES public.resources(id)      ON DELETE RESTRICT,
  resource_block_id        uuid REFERENCES public.resource_blocks(id)         ON DELETE SET NULL,
  customer_id              uuid NOT NULL REFERENCES public.customers(id)      ON DELETE RESTRICT,
  starts_at                timestamptz NOT NULL,
  ends_at                  timestamptz NOT NULL,
  status                   public.booking_status NOT NULL DEFAULT 'pending',
  total_cents              integer NOT NULL CHECK (total_cents >= 0),
  currency                 text NOT NULL DEFAULT 'usd',
  stripe_payment_intent_id text UNIQUE,
  notes                    text,
  created_by_staff_id      uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  checked_in_at            timestamptz,
  checked_in_by_staff_id   uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bookings_time_window_chk CHECK (ends_at > starts_at)
);
CREATE INDEX bookings_business_id_idx ON public.bookings(business_id);
CREATE INDEX bookings_resource_id_idx ON public.bookings(resource_id);
CREATE INDEX bookings_customer_id_idx ON public.bookings(customer_id);
CREATE INDEX bookings_status_idx      ON public.bookings(status);
CREATE INDEX bookings_starts_at_idx   ON public.bookings(starts_at);
CREATE TRIGGER bookings_set_updated_at BEFORE UPDATE ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ──────────────────────────────────────────────────────────────────────────────
-- kiosks — devices tied to resources (not businesses)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.kiosks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  pairing_code  text NOT NULL UNIQUE,
  status        public.kiosk_status NOT NULL DEFAULT 'active',
  last_seen_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER kiosks_set_updated_at BEFORE UPDATE ON public.kiosks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ──────────────────────────────────────────────────────────────────────────────
-- kiosk_resources — a kiosk can serve many resources (e.g. a dock counter)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.kiosk_resources (
  kiosk_id     uuid NOT NULL REFERENCES public.kiosks(id)     ON DELETE CASCADE,
  resource_id  uuid NOT NULL REFERENCES public.resources(id)  ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kiosk_id, resource_id)
);
CREATE INDEX kiosk_resources_resource_id_idx ON public.kiosk_resources(resource_id);

-- ──────────────────────────────────────────────────────────────────────────────
-- audit_log — append-only ops history (check-ins, payments, kiosk pairings, …)
-- ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.audit_log (
  id              bigserial PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor_staff_id  uuid REFERENCES public.staff(id)  ON DELETE SET NULL,
  actor_kiosk_id  uuid REFERENCES public.kiosks(id) ON DELETE SET NULL,
  entity          text NOT NULL,
  entity_id       uuid,
  action          text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_occurred_at_idx ON public.audit_log(occurred_at DESC);
CREATE INDEX audit_log_entity_idx      ON public.audit_log(entity, entity_id);

-- ──────────────────────────────────────────────────────────────────────────────
-- Enable RLS on every table; policies are added in the next migration.
-- (Better to ship "enabled but empty" than to forget enabling later.)
-- ──────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.businesses        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resources         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resource_blocks   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_resources   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kiosks            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kiosk_resources   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log         ENABLE ROW LEVEL SECURITY;
