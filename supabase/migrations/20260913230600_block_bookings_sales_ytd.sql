-- Block the year-to-date aggregate behind the sidebar's "Sold this year".
--
-- Applied live on 2026-09-13 at 23:06 UTC, minutes after the database came
-- back from a fifteen-minute stall at Saturday peak. The function scans the
-- year's bookings and ran on every owner page; with the analytics aggregates
-- next to it, the small compute could not keep up and every desk and tablet
-- saw errors. The sidebar no longer mounts the block, but a browser still on
-- the previous bundle keeps calling the function until it reloads, so the
-- database refuses it too (42501, cheap) instead of running it.
--
-- Nothing else calls it. Grant it back when it reads a rollup instead of the
-- bookings table.

revoke execute on function public.bookings_sales_ytd()
  from public, anon, authenticated;

comment on function public.bookings_sales_ytd() is
  'Bookings sold so far this year. Execute revoked from app roles on 2026-09-13 (peak-load stall); the sidebar block that used it is unmounted. Grant back once it is served from a rollup.';
