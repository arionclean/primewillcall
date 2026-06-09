-- Remove legacy typo column after migrating to `profile_photo`.

ALTER TABLE public.companies
DROP COLUMN IF EXISTS profile_foto;
