// Error reporting for edge functions.
//
// Wrap the handler: `Deno.serve(withSentry("gp-book", async (req) => { ... }))`.
// Two things reach Sentry, tagged with the function name and the request:
//   1. anything the handler throws (the request then fails as it would have);
//   2. any 5xx the handler returns on purpose (most functions catch their own
//      errors and answer a JSON 500; without this those never surfaced).
// Off when the SENTRY_DSN secret is unset: the wrapper is then a passthrough and
// the SDK is never initialised. The Deno SDK does not instrument Deno.serve, so
// there is no per-request scope; every capture goes through withScope with the
// context it needs, nothing is left on the global scope between requests.
// See docs/sentry.md.
import * as Sentry from "npm:@sentry/deno@10.73.0";

const dsn = Deno.env.get("SENTRY_DSN");
let initialised = false;

function ensureInit() {
  if (initialised || !dsn) return;
  Sentry.init({
    dsn,
    environment: Deno.env.get("SENTRY_ENVIRONMENT") ?? "production",
    // Errors only. Tracing would bill every webhook and cron tick.
    tracesSampleRate: 0,
    defaultIntegrations: false,
    sendDefaultPii: false,
  });
  initialised = true;
}

type Handler = (req: Request) => Response | Promise<Response>;

/** Report an error a handler caught itself (it still decides the response). */
export async function reportError(
  fn: string,
  error: unknown,
  extra?: Record<string, unknown>,
): Promise<void> {
  if (!dsn) return;
  ensureInit();
  Sentry.withScope((scope) => {
    scope.setTag("function", fn);
    if (extra) scope.setContext("details", extra);
    Sentry.captureException(error);
  });
  await Sentry.flush(2000);
}

/**
 * A heartbeat for a scheduled job, checked from OUTSIDE this platform.
 *
 * Every alarm a job raises lives inside the job, so a job that stops running (its
 * pg_cron entry gone, pg_net stuck, a rotated secret answering 401, the project down)
 * goes quiet and takes its alarms with it. Sentry's cron monitor expects a check-in
 * on the job's schedule and opens an issue when they stop or fail: the one watcher
 * that does not depend on the thing it watches. The monitor is created by the first
 * check-in (the config below), so there is nothing to set up in Sentry by hand.
 *
 * `run` counts as a failed check-in only when it throws. Off without SENTRY_DSN.
 */
export async function withCronMonitor<T>(
  slug: string,
  crontab: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!dsn) return run();
  ensureInit();
  const checkInId = Sentry.captureCheckIn(
    { monitorSlug: slug, status: "in_progress" },
    {
      schedule: { type: "crontab", value: crontab },
      timezone: "UTC",
      // A tick may start a few minutes late (pg_cron and a cold start) without it
      // counting as missed, and one missed tick alone is not an outage: two in a row
      // are, so a single slow run never pages anyone.
      checkinMargin: 5,
      maxRuntime: 5,
      failureIssueThreshold: 2,
      recoveryThreshold: 1,
    },
  );
  try {
    const result = await run();
    Sentry.captureCheckIn({ checkInId, monitorSlug: slug, status: "ok" });
    return result;
  } catch (error) {
    Sentry.captureCheckIn({ checkInId, monitorSlug: slug, status: "error" });
    throw error;
  } finally {
    await Sentry.flush(2000);
  }
}

export function withSentry(fn: string, handler: Handler): Handler {
  if (!dsn) return handler;
  return async (req: Request): Promise<Response> => {
    ensureInit();
    const request = { method: req.method, url: req.url };
    try {
      const res = await handler(req);
      if (res.status >= 500) {
        let body = "";
        try {
          body = (await res.clone().text()).slice(0, 2000);
        } catch {
          // body already consumed or not text; the status is still worth a report
        }
        Sentry.withScope((scope) => {
          scope.setTag("function", fn);
          scope.setContext("request", request);
          scope.setContext("response", { status: res.status, body });
          Sentry.captureMessage(`${fn} answered ${res.status}`, "error");
        });
        await Sentry.flush(2000);
      }
      return res;
    } catch (error) {
      Sentry.withScope((scope) => {
        scope.setTag("function", fn);
        scope.setContext("request", request);
        Sentry.captureException(error);
      });
      await Sentry.flush(2000);
      throw error;
    }
  };
}
