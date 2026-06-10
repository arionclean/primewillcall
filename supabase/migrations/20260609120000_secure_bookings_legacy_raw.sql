-- Security fix: bookings_legacy_raw was exposed via the public API.
--
-- bookings_legacy_raw is the one-time CSV import staging table. It holds raw
-- Xano booking rows (customer names, phones, emails) and is NOT used by the app.
-- With RLS off it was reachable through the anon/authenticated PostgREST API
-- (Supabase advisor: rls_disabled_in_public, ERROR/EXTERNAL).
--
-- The import writes to it with the service role key, which bypasses RLS, so
-- enabling RLS with no policies locks the table to server-side use only without
-- breaking the import. API grants are revoked as defense in depth.

alter table public.bookings_legacy_raw enable row level security;
revoke all on table public.bookings_legacy_raw from anon, authenticated;
