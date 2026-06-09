-- Tours become a two-layer model:
--   * tours          = master catalog (Prime owns; capacity + timeslots live here)
--   * business_tours = per-business variants of a master tour (custom name + pax tiers)
--   * tour_timeslots = recurring schedule per master tour, owner-managed
-- Bookings now reference business_tours (the variant).
--
-- The 1 test tour ("Miami Sunset Cruise...") and its pax tiers are deleted as
-- part of this restructure since the old row had a business_id and we are
-- changing what that column means.
--
-- The assets layer added in 20260528140000 is rolled back; capacity now lives
-- on the master tour itself, not on a separate asset.

-- 1. Wipe test data first (only the one tour + its tiers).
DELETE FROM public.tour_pax_tiers;
DELETE FROM public.bookings;
DELETE FROM public.tours;

-- 2. Drop policies that reference columns about to disappear or be renamed.
DROP POLICY IF EXISTS tours_select          ON public.tours;
DROP POLICY IF EXISTS tours_insert          ON public.tours;
DROP POLICY IF EXISTS tours_update          ON public.tours;
DROP POLICY IF EXISTS tours_delete          ON public.tours;
DROP POLICY IF EXISTS tour_pax_tiers_select ON public.tour_pax_tiers;
DROP POLICY IF EXISTS tour_pax_tiers_write  ON public.tour_pax_tiers;
DROP POLICY IF EXISTS bookings_select       ON public.bookings;
DROP POLICY IF EXISTS bookings_insert       ON public.bookings;
DROP POLICY IF EXISTS bookings_update       ON public.bookings;
DROP POLICY IF EXISTS bookings_delete       ON public.bookings;
DROP POLICY IF EXISTS kiosks_select         ON public.kiosks;
DROP POLICY IF EXISTS kiosks_write          ON public.kiosks;
DROP POLICY IF EXISTS kiosk_tours_select    ON public.kiosk_tours;
DROP POLICY IF EXISTS kiosk_tours_write     ON public.kiosk_tours;

-- 3. Drop assets table and its FK columns (the table is empty).
ALTER TABLE public.tours    DROP COLUMN IF EXISTS asset_id;
ALTER TABLE public.bookings DROP COLUMN IF EXISTS asset_id;
DROP TABLE IF EXISTS public.assets CASCADE;

-- 4. Restructure tours: drop business_id (was per-business), add capacity.
ALTER TABLE public.tours DROP COLUMN IF EXISTS business_id;
ALTER TABLE public.tours
  ADD COLUMN capacity int NOT NULL CHECK (capacity > 0);

-- 5. tour_timeslots: recurring schedule per master tour.
CREATE TABLE public.tour_timeslots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tour_id         uuid NOT NULL REFERENCES public.tours(id) ON DELETE CASCADE,
  start_time      time NOT NULL,
  duration_minutes int  NOT NULL CHECK (duration_minutes > 0),
  sort_order      int  NOT NULL DEFAULT 100,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tour_id, start_time)
);
CREATE INDEX tour_timeslots_tour_id_idx ON public.tour_timeslots(tour_id);
CREATE TRIGGER tour_timeslots_set_updated_at BEFORE UPDATE ON public.tour_timeslots
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.tour_timeslots ENABLE ROW LEVEL SECURITY;

-- 6. business_tours: per-business variant of a master tour.
CREATE TABLE public.business_tours (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tour_id      uuid NOT NULL REFERENCES public.tours(id)      ON DELETE RESTRICT,
  business_id  uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  name         text NOT NULL,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tour_id, business_id)
);
CREATE INDEX business_tours_tour_id_idx     ON public.business_tours(tour_id);
CREATE INDEX business_tours_business_id_idx ON public.business_tours(business_id);
CREATE TRIGGER business_tours_set_updated_at BEFORE UPDATE ON public.business_tours
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.business_tours ENABLE ROW LEVEL SECURITY;

-- 7. tour_pax_tiers: re-point to business_tours.
ALTER TABLE public.tour_pax_tiers DROP CONSTRAINT IF EXISTS tour_pax_tiers_tour_id_fkey;
ALTER TABLE public.tour_pax_tiers DROP CONSTRAINT IF EXISTS tour_pax_tiers_label_unique;
DROP INDEX  IF EXISTS public.tour_pax_tiers_tour_id_idx;
ALTER TABLE public.tour_pax_tiers RENAME COLUMN tour_id TO business_tour_id;
ALTER TABLE public.tour_pax_tiers
  ADD CONSTRAINT tour_pax_tiers_business_tour_id_fkey
    FOREIGN KEY (business_tour_id) REFERENCES public.business_tours(id) ON DELETE CASCADE;
ALTER TABLE public.tour_pax_tiers
  ADD CONSTRAINT tour_pax_tiers_label_unique UNIQUE (business_tour_id, label);
CREATE INDEX tour_pax_tiers_business_tour_id_idx ON public.tour_pax_tiers(business_tour_id);

-- 8. bookings: re-point to business_tours.
ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_tour_id_fkey;
DROP INDEX  IF EXISTS public.bookings_tour_id_idx;
ALTER TABLE public.bookings RENAME COLUMN tour_id TO business_tour_id;
ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_business_tour_id_fkey
    FOREIGN KEY (business_tour_id) REFERENCES public.business_tours(id) ON DELETE RESTRICT;
CREATE INDEX bookings_business_tour_id_idx ON public.bookings(business_tour_id);

-- 9. Recreate RLS policies (full list of dropped + new tables).

CREATE POLICY tours_select ON public.tours
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role IN ('owner','business_manager','check_in')));
CREATE POLICY tours_insert ON public.tours
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'));
CREATE POLICY tours_update ON public.tours
  FOR UPDATE TO authenticated
  USING      (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'));
CREATE POLICY tours_delete ON public.tours
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'));

CREATE POLICY tour_timeslots_select ON public.tour_timeslots
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role IN ('owner','business_manager','check_in')));
CREATE POLICY tour_timeslots_write ON public.tour_timeslots
  FOR ALL TO authenticated
  USING      (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'));

CREATE POLICY business_tours_select ON public.business_tours
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role IN ('business_manager','check_in') AND cs.business_id = business_tours.business_id)
    )
  );
CREATE POLICY business_tours_insert ON public.business_tours
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = business_tours.business_id)
    )
  );
CREATE POLICY business_tours_update ON public.business_tours
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = business_tours.business_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = business_tours.business_id)
    )
  );
CREATE POLICY business_tours_delete ON public.business_tours
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = business_tours.business_id)
    )
  );

CREATE POLICY tour_pax_tiers_select ON public.tour_pax_tiers
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.business_tours bt, public.current_staff() cs
      WHERE bt.id = tour_pax_tiers.business_tour_id
        AND (cs.role = 'owner' OR (cs.role IN ('business_manager','check_in') AND cs.business_id = bt.business_id))
    )
  );
CREATE POLICY tour_pax_tiers_write ON public.tour_pax_tiers
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.business_tours bt, public.current_staff() cs
      WHERE bt.id = tour_pax_tiers.business_tour_id
        AND (cs.role = 'owner' OR (cs.role = 'business_manager' AND cs.business_id = bt.business_id))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.business_tours bt, public.current_staff() cs
      WHERE bt.id = tour_pax_tiers.business_tour_id
        AND (cs.role = 'owner' OR (cs.role = 'business_manager' AND cs.business_id = bt.business_id))
    )
  );

CREATE POLICY bookings_select ON public.bookings
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = bookings.business_id)
         OR (cs.role = 'check_in' AND EXISTS (
              SELECT 1 FROM public.staff_tours st
              JOIN public.business_tours bt ON bt.tour_id = st.tour_id
              WHERE st.staff_id = cs.staff_id AND bt.id = bookings.business_tour_id))
    )
  );
CREATE POLICY bookings_insert ON public.bookings
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = bookings.business_id)
    )
  );
CREATE POLICY bookings_update ON public.bookings
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = bookings.business_id)
         OR (cs.role = 'check_in' AND EXISTS (
              SELECT 1 FROM public.staff_tours st
              JOIN public.business_tours bt ON bt.tour_id = st.tour_id
              WHERE st.staff_id = cs.staff_id AND bt.id = bookings.business_tour_id))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = bookings.business_id)
         OR (cs.role = 'check_in' AND EXISTS (
              SELECT 1 FROM public.staff_tours st
              JOIN public.business_tours bt ON bt.tour_id = st.tour_id
              WHERE st.staff_id = cs.staff_id AND bt.id = bookings.business_tour_id))
    )
  );
CREATE POLICY bookings_delete ON public.bookings
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = bookings.business_id)
    )
  );

-- Kiosks/kiosk_tours: simplified RLS during this transitional phase. Owner
-- writes, any signed-in staff can SELECT. Tighter scoping returns when we
-- rebuild kiosks admin.
CREATE POLICY kiosks_select ON public.kiosks
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role IN ('owner','business_manager','check_in')));
CREATE POLICY kiosks_write ON public.kiosks
  FOR ALL TO authenticated
  USING      (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'));
CREATE POLICY kiosk_tours_select ON public.kiosk_tours
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role IN ('owner','business_manager','check_in')));
CREATE POLICY kiosk_tours_write ON public.kiosk_tours
  FOR ALL TO authenticated
  USING      (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'));
