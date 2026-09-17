-- Recorded on 2026-09-17 from the live cron.job row. The dispatcher's job was
-- scheduled by hand from the SQL in docs/messaging-automations.md and never went
-- through the migration log, on main or anywhere else; its earliest recorded run is
-- 2026-07-15 14:09 UTC, which is where this file's stamp comes from. The command
-- below is the live one verbatim. cron.schedule() updates a job that already has
-- this name, so applying it again changes nothing.
--
-- Needs the vault secret 'dispatch_cron_secret', which is created by hand
-- (select vault.create_secret('<CRON_SECRET>', 'dispatch_cron_secret')) and is
-- never written into a migration. The same secret authenticates every cron-driven
-- function here (enqueue-review-asks, kiosk-sale-sweep, kiosk-cash-sweep,
-- xano-mirror-dispatch).

-- Every minute: send whatever is due in scheduled_messages, under the global hourly
-- cap. This is the single thing that calls Twilio for automations.
select cron.schedule(
  'dispatch-scheduled-messages',
  '* * * * *',
  $$
    select net.http_post(
      url := 'https://qbnizuhozzwkiitfkjee.supabase.co/functions/v1/dispatch-scheduled-messages',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_cron_secret')
      ),
      body := '{}'::jsonb
    );
  $$
);
