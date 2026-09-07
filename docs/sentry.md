# Sentry (error reporting)

One Sentry project receives errors from the whole system: the Next.js app on Vercel
(pages, server actions, API routes, the browser) and every Supabase edge function.
Nothing is sent until the DSN is configured; with it unset, every hook below is a
no-op, so local development is unaffected.

## What is covered

| Where | How | File |
| --- | --- | --- |
| Browser (client components, fetches) | `@sentry/nextjs`, loaded before hydration | `src/instrumentation-client.ts` |
| Server components, server actions, route handlers | `register()` + `onRequestError` | `src/instrumentation.ts`, `src/sentry.server.config.ts` |
| Middleware (edge runtime) | same, edge build | `src/sentry.edge.config.ts` |
| A crash of the root layout | reported, then a plain retry screen | `src/app/global-error.tsx` |
| Edge functions (all 18) | `withSentry(name, handler)` around `Deno.serve` | `supabase/functions/_shared/sentry.ts` |

The edge wrapper reports two things: anything a handler throws, and any 5xx a
handler returns on purpose (most functions catch their own errors and answer a JSON
500, which used to vanish into the function log). Both carry the function name and
the request method + URL. `reportError(fn, error, extra)` is there for a handler that
wants to report something it recovers from.

Not covered: work inside Postgres (pg_cron jobs, triggers). Those log to their own
tables; if one needs alerting, a scheduled edge function that reads the failures and
calls `reportError` is the pattern.

## Privacy

`sendDefaultPii` is off everywhere and session replay is not enabled on purpose:
the screens carry guest names and phone numbers. An event holds the stack trace, the
URL and the request method, not the request body or the form values.

## Configuration

Create one Sentry project (platform: Next.js), then set:

| Where | Variable | Value |
| --- | --- | --- |
| Vercel (all environments) | `NEXT_PUBLIC_SENTRY_DSN` | the project DSN |
| Vercel (production only, optional) | `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` | for readable stack traces (source map upload at build time) |
| Supabase secrets | `SENTRY_DSN` | the same DSN |
| Supabase secrets (optional) | `SENTRY_ENVIRONMENT` | defaults to `production` |

The DSN is a public write-only key (it lets a client send events in, nothing else),
which is why the web app can expose it as `NEXT_PUBLIC_`. The auth token is a real
secret and stays in Vercel.

```bash
supabase secrets set SENTRY_DSN=https://...@....ingest.sentry.io/... --project-ref qbnizuhozzwkiitfkjee
```

The edge functions pick the secret up on their next deploy:

```bash
for f in supabase/functions/*/; do n=$(basename "$f"); [ "$n" = "_shared" ] && continue; supabase functions deploy "$n" --project-ref qbnizuhozzwkiitfkjee --use-api; done
```

## Sampling

Errors are always sent. Performance traces are sampled at 10% in production for the
web app and switched off for edge functions (every webhook and cron tick would
otherwise become a billed transaction).
