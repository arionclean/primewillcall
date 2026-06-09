-- Drop the jet-ski assumption from resources.kind.
-- Prime sells across multiple business types, not just jet skis, so we keep
-- the column as free-form text but stop defaulting it.
ALTER TABLE public.resources ALTER COLUMN kind DROP DEFAULT;
