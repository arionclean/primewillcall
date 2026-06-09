-- Logo support for businesses.
-- 1. Add logo_url column.
-- 2. Create a public 'business-logos' storage bucket with size + MIME guards.
-- 3. RLS on storage.objects: owners write, public read.

ALTER TABLE public.businesses
  ADD COLUMN logo_url text;

-- Bucket setup (idempotent via ON CONFLICT).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'business-logos',
  'business-logos',
  true,
  2097152, -- 2 MB
  ARRAY['image/png','image/jpeg','image/jpg','image/webp','image/svg+xml']::text[]
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Storage policies. Drop any prior versions before recreating so this migration
-- stays re-runnable while we iterate.
DROP POLICY IF EXISTS business_logos_select   ON storage.objects;
DROP POLICY IF EXISTS business_logos_insert   ON storage.objects;
DROP POLICY IF EXISTS business_logos_update   ON storage.objects;
DROP POLICY IF EXISTS business_logos_delete   ON storage.objects;

CREATE POLICY business_logos_select ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'business-logos');

CREATE POLICY business_logos_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'business-logos'
    AND EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner')
  );

CREATE POLICY business_logos_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'business-logos'
    AND EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner')
  )
  WITH CHECK (
    bucket_id = 'business-logos'
    AND EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner')
  );

CREATE POLICY business_logos_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'business-logos'
    AND EXISTS (SELECT 1 FROM public.current_staff() cs WHERE cs.role = 'owner')
  );
