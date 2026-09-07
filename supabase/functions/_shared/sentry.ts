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
