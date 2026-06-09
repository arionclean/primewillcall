-- Per-master-tour instructions + meeting point. Shared across all business
-- variants since they are physical/operational facts, not marketing.
ALTER TABLE public.tours
  ADD COLUMN instructions          text,
  ADD COLUMN meeting_point_address text,
  ADD COLUMN meeting_point_lat     numeric(9,6),
  ADD COLUMN meeting_point_lng     numeric(9,6);

-- Sanity-check lat/lng if provided.
ALTER TABLE public.tours
  ADD CONSTRAINT tours_meeting_point_lat_chk
    CHECK (meeting_point_lat IS NULL OR (meeting_point_lat >= -90  AND meeting_point_lat <= 90)),
  ADD CONSTRAINT tours_meeting_point_lng_chk
    CHECK (meeting_point_lng IS NULL OR (meeting_point_lng >= -180 AND meeting_point_lng <= 180));
