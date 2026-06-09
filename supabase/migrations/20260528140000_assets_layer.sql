-- Add a master-level "assets" layer (boats, vans, studios, etc.).
-- Assets are owned by Prime (no business_id). Multiple businesses can have
-- tours that reference the same asset, and capacity is enforced PER ASSET.

CREATE TABLE public.assets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'boat',
  capacity    int  NOT NULL CHECK (capacity > 0),
  timezone    text NOT NULL DEFAULT 'America/New_York',
  notes       text,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX assets_kind_idx ON public.assets(kind);
CREATE TRIGGER assets_set_updated_at BEFORE UPDATE ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
ALTER TABLE public.assets ENABLE ROW LEVEL SECURITY;

-- RLS: any signed-in staff can SELECT, only owner can write.
CREATE POLICY assets_select ON public.assets
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.current_staff() cs
      WHERE cs.role IN ('owner', 'business_manager', 'check_in')
    )
  );

CREATE POLICY assets_insert ON public.assets
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner')
  );

CREATE POLICY assets_update ON public.assets
  FOR UPDATE TO authenticated
  USING      (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'));

CREATE POLICY assets_delete ON public.assets
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner'));

-- Tours: capacity now lives on assets. Drop the per-tour soft cap.
ALTER TABLE public.tours DROP COLUMN default_capacity;

-- Tours reference an asset. Nullable for now so the one pre-existing tour
-- ("Miami Sunset Cruise...") survives the migration. The UI will require an
-- asset on any newly created or edited tour going forward.
ALTER TABLE public.tours
  ADD COLUMN asset_id uuid REFERENCES public.assets(id) ON DELETE RESTRICT;
CREATE INDEX tours_asset_id_idx ON public.tours(asset_id);

-- Bookings: denormalize asset_id so concurrent-pax / capacity queries are fast
-- without needing to join tours. Nullable for the same reason as tours.
ALTER TABLE public.bookings
  ADD COLUMN asset_id uuid REFERENCES public.assets(id) ON DELETE RESTRICT;
CREATE INDEX bookings_asset_id_idx ON public.bookings(asset_id);
