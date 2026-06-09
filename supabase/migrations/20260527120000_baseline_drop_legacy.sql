-- Baseline migration: wipe legacy Xano-era schema before the new Master/Resources/Businesses model.
-- All target tables were confirmed empty at 2026-05-27 via list_tables on Supabase project qbnizuhozzwkiitfkjee.

-- Drop trigger on auth.users first (CASCADE on public tables won't reach into the auth schema).
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

-- Drop all legacy public tables (CASCADE removes their indexes, triggers, policies, FKs).
DROP TABLE IF EXISTS public.kiosk_sales            CASCADE;
DROP TABLE IF EXISTS public.team_member_products   CASCADE;
DROP TABLE IF EXISTS public.team_members           CASCADE;
DROP TABLE IF EXISTS public.customer_id_map        CASCADE;
DROP TABLE IF EXISTS public.product_id_map         CASCADE;
DROP TABLE IF EXISTS public.stg_bookings_raw       CASCADE;
DROP TABLE IF EXISTS public.bookings               CASCADE;
DROP TABLE IF EXISTS public.products               CASCADE;
DROP TABLE IF EXISTS public.customers              CASCADE;
DROP TABLE IF EXISTS public.companies              CASCADE;
DROP TABLE IF EXISTS public.app_users              CASCADE;

-- Drop legacy helper / RLS / migration functions.
DROP FUNCTION IF EXISTS public.active_team_member_for_company(uuid)         CASCADE;
DROP FUNCTION IF EXISTS public.team_member_can_access_product(uuid)         CASCADE;
DROP FUNCTION IF EXISTS public.team_member_can_create_booking(uuid, uuid)   CASCADE;
DROP FUNCTION IF EXISTS public.team_member_has_permission(uuid, text)       CASCADE;
DROP FUNCTION IF EXISTS public.handle_new_auth_user()                       CASCADE;
DROP FUNCTION IF EXISTS public.set_updated_at()                             CASCADE;
DROP FUNCTION IF EXISTS public.normalize_legacy_text(text)                  CASCADE;
DROP FUNCTION IF EXISTS public.safe_bool(text, boolean)                     CASCADE;
DROP FUNCTION IF EXISTS public.safe_int(text, integer)                      CASCADE;
DROP FUNCTION IF EXISTS public.safe_timestamptz(text)                       CASCADE;
DROP FUNCTION IF EXISTS public.backfill_product_id_map_from_names()         CASCADE;
DROP FUNCTION IF EXISTS public.migrate_legacy_customers()                   CASCADE;
DROP FUNCTION IF EXISTS public.migrate_legacy_bookings()                    CASCADE;
