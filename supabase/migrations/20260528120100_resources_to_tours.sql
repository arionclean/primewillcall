-- Rename the "resources" model to "tours" and add per-pax pricing fields.
--
-- Why: Prime runs multi-business tour / scheduled-experience operations across
-- different verticals. The "resources" naming and resource_blocks (hour-block)
-- pricing model presumed an equipment-rental business, which is wrong.
--
-- This migration is safe because all affected tables are empty.

-- 1. Drop policies that reference the renamed tables/columns.
DROP POLICY IF EXISTS resources_select        ON public.resources;
DROP POLICY IF EXISTS resources_insert        ON public.resources;
DROP POLICY IF EXISTS resources_update        ON public.resources;
DROP POLICY IF EXISTS resources_delete        ON public.resources;
DROP POLICY IF EXISTS resource_blocks_select  ON public.resource_blocks;
DROP POLICY IF EXISTS resource_blocks_write   ON public.resource_blocks;
DROP POLICY IF EXISTS staff_resources_select  ON public.staff_resources;
DROP POLICY IF EXISTS staff_resources_write   ON public.staff_resources;
DROP POLICY IF EXISTS kiosk_resources_select  ON public.kiosk_resources;
DROP POLICY IF EXISTS kiosk_resources_write   ON public.kiosk_resources;
DROP POLICY IF EXISTS kiosks_select           ON public.kiosks;
DROP POLICY IF EXISTS bookings_select         ON public.bookings;
DROP POLICY IF EXISTS bookings_insert         ON public.bookings;
DROP POLICY IF EXISTS bookings_update         ON public.bookings;
DROP POLICY IF EXISTS bookings_delete         ON public.bookings;

-- 2. Drop resource_blocks (replaced by tour_pax_tiers below) and the bookings.resource_block_id FK.
ALTER TABLE public.bookings DROP COLUMN IF EXISTS resource_block_id;
DROP TABLE IF EXISTS public.resource_blocks CASCADE;

-- 3. Rename resources → tours.
ALTER TABLE public.resources RENAME TO tours;
ALTER INDEX resources_business_id_idx RENAME TO tours_business_id_idx;
ALTER TRIGGER resources_set_updated_at ON public.tours RENAME TO tours_set_updated_at;
ALTER TABLE public.tours RENAME CONSTRAINT resources_pkey TO tours_pkey;
ALTER TABLE public.tours RENAME CONSTRAINT resources_business_id_fkey TO tours_business_id_fkey;

-- 4. Rename bookings.resource_id → tour_id (and its index + FK).
ALTER TABLE public.bookings RENAME COLUMN resource_id TO tour_id;
ALTER INDEX bookings_resource_id_idx RENAME TO bookings_tour_id_idx;
ALTER TABLE public.bookings RENAME CONSTRAINT bookings_resource_id_fkey TO bookings_tour_id_fkey;

-- 5. Rename staff_resources → staff_tours (column + index + FKs).
ALTER TABLE public.staff_resources RENAME TO staff_tours;
ALTER TABLE public.staff_tours RENAME COLUMN resource_id TO tour_id;
ALTER INDEX staff_resources_resource_id_idx RENAME TO staff_tours_tour_id_idx;
ALTER TABLE public.staff_tours RENAME CONSTRAINT staff_resources_pkey         TO staff_tours_pkey;
ALTER TABLE public.staff_tours RENAME CONSTRAINT staff_resources_resource_id_fkey TO staff_tours_tour_id_fkey;
ALTER TABLE public.staff_tours RENAME CONSTRAINT staff_resources_staff_id_fkey    TO staff_tours_staff_id_fkey;

-- 6. Rename kiosk_resources → kiosk_tours (column + index + FKs).
ALTER TABLE public.kiosk_resources RENAME TO kiosk_tours;
ALTER TABLE public.kiosk_tours RENAME COLUMN resource_id TO tour_id;
ALTER INDEX kiosk_resources_resource_id_idx RENAME TO kiosk_tours_tour_id_idx;
ALTER TABLE public.kiosk_tours RENAME CONSTRAINT kiosk_resources_pkey            TO kiosk_tours_pkey;
ALTER TABLE public.kiosk_tours RENAME CONSTRAINT kiosk_resources_kiosk_id_fkey   TO kiosk_tours_kiosk_id_fkey;
ALTER TABLE public.kiosk_tours RENAME CONSTRAINT kiosk_resources_resource_id_fkey TO kiosk_tours_tour_id_fkey;

-- 7. Add soft-cap on tours.
ALTER TABLE public.tours
  ADD COLUMN default_capacity int
    CHECK (default_capacity IS NULL OR default_capacity > 0);

-- 8. Add per-pax denormalized counts + breakdown JSONB on bookings.
ALTER TABLE public.bookings
  ADD COLUMN pax_adult   int NOT NULL DEFAULT 0 CHECK (pax_adult   >= 0),
  ADD COLUMN pax_child   int NOT NULL DEFAULT 0 CHECK (pax_child   >= 0),
  ADD COLUMN pax_infant  int NOT NULL DEFAULT 0 CHECK (pax_infant  >= 0),
  ADD COLUMN tour_pax_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.bookings.tour_pax_breakdown IS
  'Snapshot of the pax tiers applied at booking time. Array of objects: [{"label": "adult", "count": 2, "price_cents": 5000}, ...]. Price changes on tour_pax_tiers later do not rewrite this history.';

-- 9. New table: tour_pax_tiers (price per pax type per tour).
CREATE TABLE public.tour_pax_tiers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tour_id      uuid NOT NULL REFERENCES public.tours(id) ON DELETE CASCADE,
  label        text NOT NULL,
  description  text,
  price_cents  int  NOT NULL CHECK (price_cents >= 0),
  currency     text NOT NULL DEFAULT 'usd',
  sort_order   int  NOT NULL DEFAULT 100,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tour_pax_tiers_label_unique UNIQUE (tour_id, label)
);
CREATE INDEX tour_pax_tiers_tour_id_idx ON public.tour_pax_tiers(tour_id);
CREATE TRIGGER tour_pax_tiers_set_updated_at BEFORE UPDATE ON public.tour_pax_tiers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.tour_pax_tiers ENABLE ROW LEVEL SECURITY;

-- 10. Recreate policies with the new names.

-- tours
CREATE POLICY tours_select ON public.tours
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = tours.business_id)
         OR (cs.role = 'check_in' AND EXISTS (
               SELECT 1 FROM public.staff_tours st
               WHERE st.staff_id = cs.staff_id AND st.tour_id = tours.id))
    )
  );
CREATE POLICY tours_insert ON public.tours
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = tours.business_id)
    )
  );
CREATE POLICY tours_update ON public.tours
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = tours.business_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = tours.business_id)
    )
  );
CREATE POLICY tours_delete ON public.tours
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = tours.business_id)
    )
  );

-- tour_pax_tiers
CREATE POLICY tour_pax_tiers_select ON public.tour_pax_tiers
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.tours t, public.current_staff() cs
      WHERE t.id = tour_pax_tiers.tour_id
        AND (
          cs.role = 'owner'
          OR (cs.role = 'business_manager' AND cs.business_id = t.business_id)
          OR (cs.role = 'check_in' AND EXISTS (
                SELECT 1 FROM public.staff_tours st
                WHERE st.staff_id = cs.staff_id AND st.tour_id = t.id))
        )
    )
  );
CREATE POLICY tour_pax_tiers_write ON public.tour_pax_tiers
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.tours t, public.current_staff() cs
      WHERE t.id = tour_pax_tiers.tour_id
        AND (cs.role = 'owner'
             OR (cs.role = 'business_manager' AND cs.business_id = t.business_id))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.tours t, public.current_staff() cs
      WHERE t.id = tour_pax_tiers.tour_id
        AND (cs.role = 'owner'
             OR (cs.role = 'business_manager' AND cs.business_id = t.business_id))
    )
  );

-- staff_tours
CREATE POLICY staff_tours_select ON public.staff_tours
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.staff s, public.current_staff() cs
      WHERE s.id = staff_tours.staff_id
        AND (cs.role = 'owner'
             OR (cs.role = 'business_manager' AND cs.business_id = s.business_id)
             OR cs.staff_id = s.id)
    )
  );
CREATE POLICY staff_tours_write ON public.staff_tours
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.staff s, public.current_staff() cs
      WHERE s.id = staff_tours.staff_id
        AND (cs.role = 'owner'
             OR (cs.role = 'business_manager' AND cs.business_id = s.business_id))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.staff s, public.current_staff() cs
      WHERE s.id = staff_tours.staff_id
        AND (cs.role = 'owner'
             OR (cs.role = 'business_manager' AND cs.business_id = s.business_id))
    )
  );

-- kiosk_tours
CREATE POLICY kiosk_tours_select ON public.kiosk_tours
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.tours t, public.current_staff() cs
      WHERE t.id = kiosk_tours.tour_id
        AND (cs.role = 'owner'
             OR (cs.role = 'business_manager' AND cs.business_id = t.business_id)
             OR (cs.role = 'check_in' AND EXISTS (
                   SELECT 1 FROM public.staff_tours st
                   WHERE st.staff_id = cs.staff_id AND st.tour_id = t.id)))
    )
  );
CREATE POLICY kiosk_tours_write ON public.kiosk_tours
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.tours t, public.current_staff() cs
      WHERE t.id = kiosk_tours.tour_id
        AND (cs.role = 'owner'
             OR (cs.role = 'business_manager' AND cs.business_id = t.business_id))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.tours t, public.current_staff() cs
      WHERE t.id = kiosk_tours.tour_id
        AND (cs.role = 'owner'
             OR (cs.role = 'business_manager' AND cs.business_id = t.business_id))
    )
  );

-- kiosks_select (was joining kiosk_resources + resources; now kiosk_tours + tours)
CREATE POLICY kiosks_select ON public.kiosks
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR EXISTS (
              SELECT 1
              FROM public.kiosk_tours kt
              JOIN public.tours t ON t.id = kt.tour_id
              WHERE kt.kiosk_id = kiosks.id
                AND (
                  (cs.role = 'business_manager' AND cs.business_id = t.business_id)
                  OR (cs.role = 'check_in' AND EXISTS (
                       SELECT 1 FROM public.staff_tours st
                       WHERE st.staff_id = cs.staff_id AND st.tour_id = t.id))
                )
            )
    )
  );

-- bookings
CREATE POLICY bookings_select ON public.bookings
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = bookings.business_id)
         OR (cs.role = 'check_in' AND EXISTS (
              SELECT 1 FROM public.staff_tours st
              WHERE st.staff_id = cs.staff_id AND st.tour_id = bookings.tour_id))
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
              WHERE st.staff_id = cs.staff_id AND st.tour_id = bookings.tour_id))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role = 'owner'
         OR (cs.role = 'business_manager' AND cs.business_id = bookings.business_id)
         OR (cs.role = 'check_in' AND EXISTS (
              SELECT 1 FROM public.staff_tours st
              WHERE st.staff_id = cs.staff_id AND st.tour_id = bookings.tour_id))
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
