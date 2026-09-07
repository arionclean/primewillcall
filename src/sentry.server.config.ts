// Sentry for the Node runtime: server components, server actions, route
// handlers. Off when NEXT_PUBLIC_SENTRY_DSN is unset. The same public DSN is
// used on the server; a DSN only lets a client send events in, it grants no
// read access, so it is not a secret.
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,
  sendDefaultPii: false,
});
