// Sentry in the browser. Loaded by Next before the app hydrates (Next 15's
// instrumentation-client hook), so a crash in a client component, a failed
// fetch, or an unhandled promise reaches Sentry with the page and user agent.
//
// Off when NEXT_PUBLIC_SENTRY_DSN is unset (local dev without a project): the
// SDK treats a missing DSN as "do nothing". Session replay is deliberately not
// enabled: the screens carry guest names and phones, and a replay would record
// them. See docs/sentry.md.
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
  // Errors always; performance traces on a 10% sample in production.
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,
  sendDefaultPii: false,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
