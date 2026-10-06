-- Recovered on 2026-09-17 from the database's migration log (applied 2026-09-02
-- 16:08 UTC). docs/review-automation.md shows this SQL, but no migration on main
-- carried it, so the job that drives the review funnel had no record in the schema.
-- Verbatim what ran. cron.schedule() updates a job that already has this name, so
-- applying it again changes nothing.

-- Schedule the review ask + re-ask sweep.
--
-- Held back until now on purpose: enqueue-review-asks was deployed and verified
-- returning `skipped` through the cron path, but never scheduled, so flipping
-- review_automation_enabled on its own did nothing. This is the last step.
--
-- Every 15 minutes. The sweep is idempotent (it skips any booking already in the
-- reviews table) and its own brakes bound what it can pick up, so the interval
-- only controls how promptly a guest is asked, never how many are asked.
--
-- Auth is the shared cron secret, the same one dispatch-scheduled-messages uses:
-- the function is deployed with JWT off because pg_cron cannot present a Supabase
-- token.
select cron.schedule(
  'enqueue-review-asks',
  '*/15 * * * *',
  $$
    select net.http_post(
      url := 'https://qbnizuhozzwkiitfkjee.supabase.co/functions/v1/enqueue-review-asks',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_cron_secret')
      ),
      body := '{}'::jsonb
    );
  $$
);
