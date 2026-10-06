-- Card sales: one Xano copy per sale, never two.
--
-- mirrorAndRecord (_shared/kiosk-sale.ts) posts a paid kiosk sale to Xano so the
-- older iPads see it. It ran with no claim: the tablet's kiosk-sale-complete and
-- the once-a-minute kiosk-sale-sweep could both post the same sale, and did. Six
-- of one week's 138 card sales landed in Xano twice, every one of them in the
-- first seconds of a minute, which is when the cron tick lands.
--
-- xano_mirror_claimed_at: a caller claims the sale with one guarded UPDATE before
-- it posts anything. A claim older than two minutes is a copy that died mid-way
-- (the isolate was torn down) and may be taken over. Given back on a clean
-- failure, so the sweep's retry is not held up.
--
-- xano_booking_attempted_at: stamped just before the booking POST. A retry that
-- finds it set with no booking id knows a copy may already exist in Xano and looks
-- it up by internal id (read-only) instead of posting a second one.
--
-- Additive. Nothing reads either column until the functions that use them ship.
alter table public.kiosk_sales
  add column if not exists xano_mirror_claimed_at timestamptz,
  add column if not exists xano_booking_attempted_at timestamptz;

comment on column public.kiosk_sales.xano_mirror_claimed_at is
  'Set by whoever is copying this sale to Xano right now; stale after two minutes; null once copied or on a clean failure.';
comment on column public.kiosk_sales.xano_booking_attempted_at is
  'Set just before the Xano booking POST. Set with no xano_booking_id means a copy may exist: look it up before posting again.';
