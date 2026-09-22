-- Xano's confirmation code on our bookings, so the old ticket links keep opening
-- once Bubble is gone.
--
-- Every booking born in Xano (the OTA email connector, the iPads) is still texted a
-- `bked.io/booking/<code>` link by Xano. That code is Xano's bookingConfirmation_id.
-- bked.io is a 301 at the registrar to pro.primewillcall.com, the Bubble app; once
-- that subdomain points at this app instead, the code lands on /booking/<code> here,
-- and the page must recognise it.
--
-- We hold it for only a minority of bookings. xano-booking-sync copies it into
-- public_token when it CREATES a row, but 77% of recent bookings were created here
-- first, from the OTA email, and by the time Xano's echo reaches the sync the code
-- is not on the row yet (Xano mints it after its insert trigger fires), so it never
-- arrives. public_token cannot be overwritten later either: our own texts already
-- carry it.
--
-- So it gets its own column, filled by the xano-ticket-tokens sweep (read-only on
-- Xano, one GET per booking by internal id, verified against the booking reference
-- before it is stamped). Upcoming bookings only: a link for a tour that has already
-- happened is not worth a call. The sweep and the column both retire with Xano.

alter table public.bookings
  add column if not exists xano_confirmation_token text;

comment on column public.bookings.xano_confirmation_token is
  'Xano''s bookingConfirmation_id: the code in the bked.io/booking/<code> link Xano texted the guest. Filled by the xano-ticket-tokens sweep for upcoming bookings; /booking/[token] accepts it as a second id. Retires with Xano.';

create index if not exists bookings_xano_confirmation_token_idx
  on public.bookings (xano_confirmation_token)
  where xano_confirmation_token is not null;

-- Hourly. Each run stamps at most 200 bookings, so the first day works through the
-- backlog (about 1,100 upcoming bookings) without a burst of GETs at Xano, and
-- after that a run touches only the day's new bookings.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'xano-ticket-tokens') then
    perform cron.unschedule('xano-ticket-tokens');
  end if;
end $$;

select cron.schedule(
  'xano-ticket-tokens',
  '17 * * * *',
  $cron$
    select net.http_post(
      url := 'https://qbnizuhozzwkiitfkjee.supabase.co/functions/v1/xano-ticket-tokens',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_cron_secret')
      ),
      body := '{}'::jsonb
    );
  $cron$
);
