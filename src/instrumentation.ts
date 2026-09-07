// Server-side Sentry. Next calls register() once per runtime when the server
// starts, and onRequestError for every error thrown while rendering a page,
// running a server action or handling a route, including the ones Next would
// otherwise only print to the Vercel log. See docs/sentry.md.
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
