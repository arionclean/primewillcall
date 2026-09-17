-- Recovered on 2026-09-17 from the database's migration log. The job was scheduled
-- on 2026-09-10 at 21:22 UTC and replaced two minutes later by this version, which
-- adds the timeout (the two log entries are cron_kiosk_cash_sweep and
-- cron_kiosk_cash_sweep_timeout). The function itself was an untracked file until
-- the same day this was written. cron.schedule() updates a job that already has
-- this name, so applying it again changes nothing.

-- Import the cash sales the tablet gave Xano and never gave us.
--
-- A cash sale is two independent calls from the tablet, one to each stack, and
-- nothing retries the second. On 2026-09-10 a $40 sale on kiosk3 reached Xano and
-- never reached us: no request in our logs at all. The kiosk's Sales screen then
-- read $701 against Xano's $741 and only a hand comparison found it.
--
-- Card sales on flow v2 are safe because the server writes both sides and
-- kiosk-sale-sweep retries the Xano half. Cash still uses the tablet's two calls,
-- on every kiosk and every build, so it needs the mirror image: read Xano, import
-- what is missing. Every five minutes is soon enough for a screen someone reads at
-- the end of a shift, and it is ten Xano reads a run, not one per sale.
--
-- The import is idempotent (dedup_key "xano-cash:<xano id>"), and Xano is only read.
--
-- pg_net gives up after 5 seconds by default, and this sweep reads ten kiosk-days
-- from Xano. The work still ran, but the caller never saw the result, which makes a
-- failure invisible. 25 seconds is the same order as the function's own Xano timeout.

select cron.schedule(
  'kiosk-cash-sweep',
  '*/5 * * * *',
  $$
    select net.http_post(
      url := 'https://qbnizuhozzwkiitfkjee.supabase.co/functions/v1/kiosk-cash-sweep',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 25000
    );
  $$
);
