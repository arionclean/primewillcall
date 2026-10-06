/**
 * The preflight answer for functions the staff app calls from the browser.
 *
 * supabase-js adds two headers the shared list (corsHeaders in sms.ts) does not
 * allow, and the browser blocks the whole call when the preflight leaves one out:
 *   x-region       sent when a call pins a region (the Stripe screens pin
 *                  us-west-2, next to the database);
 *   x-employee-id  sent on every request from a shared-computer login with an
 *                  employee unlocked (src/lib/supabase/client.ts).
 */

import { corsHeaders } from "./sms.ts";

export const BROWSER_PREFLIGHT_HEADERS = {
  ...corsHeaders,
  "access-control-allow-headers": `${corsHeaders["access-control-allow-headers"]}, x-region, x-employee-id`,
};
