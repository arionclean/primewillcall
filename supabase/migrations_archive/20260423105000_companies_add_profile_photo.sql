-- Add canonical company profile photo column
-- Keep legacy `profile_foto` for backward compatibility.

ALTER TABLE public.companies
ADD COLUMN IF NOT EXISTS profile_photo text;

-- Backfill from legacy column when available.
UPDATE public.companies
SET profile_photo = profile_foto
WHERE profile_photo IS NULL
  AND profile_foto IS NOT NULL;
