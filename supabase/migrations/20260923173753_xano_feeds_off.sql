-- Xano shutdown: stop the copy of every booking change into Xano, and the cron
-- jobs that still call it.
--
-- As of 2026-09-23 nothing reads Xano's copy of PWC: every working tablet runs the
-- Xano-free build (25), OTA email arrives through the Mailroom, Groupon through /gp,
-- and Make is off. That afternoon Xano's request log showed only this platform's own
-- edge functions (and Stripe) calling it.
--
--   * xano_mirror_settings.enabled = false stops the outbox: the enqueue trigger adds
--     nothing and xano-mirror-dispatch sends nothing. updated_at records the moment the
--     copy stopped, and enqueue-review-asks reads it: Xano's review funnel only heard of
--     a check-in through this mirror, so every guest checked in from that moment is
--     ours to ask. Guests checked in before it keep the ask Xano already queued.
--   * The cron jobs that call Xano go: xano-mirror-dispatch (the outbox worker),
--     xano-ticket-tokens (copied Xano's ticket codes for the old bked.io links; 1,031
--     of the 1,047 upcoming Xano-born bookings have theirs, the other 16 never matched)
--     and kiosk-cash-sweep (read Xano's cash_sales for tablets that wrote only there;
--     none does now).
--
-- Set the same day, as function secrets rather than here: GP_XANO_MIRROR=false (the
-- /gp copy) and KIOSK_V2_XANO_MIRROR=false (the kiosk card sale copy). The inbound SMS
-- copy (XANO_SMS_FORWARD_URL) stays on until Xano itself is turned off, so guests'
-- replies to the review requests Xano already sent still reach it.

update public.xano_mirror_settings set enabled = false, updated_at = now() where id;

do $$
declare
  j text;
begin
  foreach j in array array['xano-mirror-dispatch', 'xano-ticket-tokens', 'kiosk-cash-sweep'] loop
    if exists (select 1 from cron.job where jobname = j) then
      perform cron.unschedule(j);
    end if;
  end loop;
end $$;
