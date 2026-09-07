-- Caja becomes a per-staff switch.
--
--   can_use_caja   default on   open /caja: the desk's own cash and card for the
--                               day, plus the end-of-night count
--
-- Until now every check-in login had Caja by virtue of its role. The owner can now
-- turn it off for a tablet that only checks guests in. Default on, so no existing
-- account loses the screen. Owners and managers are unaffected (they use the full
-- /admin/payments ledger and are sent there by the page).
--
-- Enforced in layers like the other switches: the sidebar hides the link, the page
-- redirects, and RLS fails closed. The per-kiosk money policies key on
-- current_kiosk_slug(), so that function now returns NULL for a check-in login
-- without the switch, and the kiosk's cash_sales / stripe_transactions rows stop
-- matching for that account.

ALTER TABLE public.staff
  ADD COLUMN IF NOT EXISTS can_use_caja boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.staff.can_use_caja IS
  'May open Caja (the desk''s own cash + card for the day and the end-of-night count). Check-in logins only; owners and managers use /admin/payments.';

-- ── The access token carries the new column ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  s      public.staff%ROWTYPE;
  claims jsonb;
BEGIN
  SELECT * INTO s
  FROM public.staff
  WHERE user_id = (event->>'user_id')::uuid
  LIMIT 1;

  claims := event->'claims';

  IF s.id IS NULL THEN
    claims := jsonb_set(claims, '{app_staff}', 'null'::jsonb);
  ELSE
    claims := jsonb_set(claims, '{app_staff}', jsonb_build_object(
      'id',                   s.id,
      'full_name',            s.full_name,
      'role',                 s.role,
      'business_id',          s.business_id,
      'is_active',            s.is_active,
      'kiosk_slug',           s.kiosk_slug,
      'can_create_bookings',  s.can_create_bookings,
      'can_edit_bookings',    s.can_edit_bookings,
      'can_check_in',         s.can_check_in,
      'can_delete_bookings',  s.can_delete_bookings,
      'can_add_to_peek',      s.can_add_to_peek,
      'can_view_attachments', s.can_view_attachments,
      'can_redeem_groupon',   s.can_redeem_groupon,
      'can_view_details',     s.can_view_details,
      'can_use_caja',         s.can_use_caja
    ));
  END IF;

  RETURN jsonb_set(event, '{claims}', claims);
END;
$$;

-- ── RLS backstop: no kiosk identity without the switch ──────────────────────
-- Same body as 20260723190000 plus the switch. Every Caja read policy compares a
-- row's kiosk slug to this, so NULL means "sees no kiosk money".
CREATE OR REPLACE FUNCTION public.current_kiosk_slug()
  RETURNS text
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO 'pg_catalog', 'public'
AS $$
  SELECT s.kiosk_slug
  FROM public.staff s
  WHERE s.user_id = auth.uid()
    AND s.role = 'check_in'
    AND s.is_active = true
    AND s.can_use_caja = true
  LIMIT 1
$$;
