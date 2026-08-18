// Backfill/refresh sms_messages from the Twilio Messages API. Supabase-native
// replacement for the Vercel route src/app/api/sms/sync/route.ts.
//
// Twilio is the shared source of truth while Xano coexists: messages Xano sends
// (booking confirmations, campaigns) only reach our log through here. Incremental:
// only fetches messages sent after our latest logged row (with a 1-day overlap),
// deduped by twilio_sid.
//
// Deployed with JWT ON. Owner and business_manager only, same as the route it replaces.

import {
  ACCOUNT_SID,
  corsHeaders,
  db,
  json,
  TWILIO_HOST,
  twilioAuthHeader,
  twilioFromNumber,
} from "../_shared/sms.ts";
import { requireStaff } from "../_shared/staff-auth.ts";

const PAGE_SIZE = 100;
const MAX_PAGES_PER_DIRECTION = 10;

interface TwilioApiMessage {
  sid: string;
  from: string;
  to: string;
  body: string | null;
  status: string;
  direction: string;
  date_sent: string | null;
  date_created: string;
}

interface TwilioMessagesPage {
  messages?: TwilioApiMessage[];
  next_page_uri?: string | null;
}

async function fetchTwilioPage(uri: string): Promise<TwilioMessagesPage> {
  const response = await fetch(`${TWILIO_HOST}${uri}`, {
    headers: { Authorization: twilioAuthHeader() },
  });
  if (!response.ok) {
    throw new Error(`Twilio message list failed with status ${response.status}`);
  }
  return await response.json() as TwilioMessagesPage;
}

async function syncMessagesFromTwilio(): Promise<{ imported: number; pagesFetched: number }> {
  if (!ACCOUNT_SID) throw new Error("TWILIO_ACCOUNT_SID not configured");
  const ourNumber = twilioFromNumber();

  const { data: latest } = await db
    .from("sms_messages")
    .select("created_at")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let sentAfter: string | null = null;
  if (latest?.created_at) {
    const overlap = new Date(new Date(latest.created_at).getTime() - 24 * 60 * 60 * 1000);
    sentAfter = overlap.toISOString().slice(0, 10);
  }

  let imported = 0;
  let pagesFetched = 0;

  // Two passes: inbound to our number, outbound from our number.
  const filters: Array<Record<string, string>> = [{ To: ourNumber }, { From: ourNumber }];
  for (const filter of filters) {
    const params = new URLSearchParams({ PageSize: String(PAGE_SIZE), ...filter });
    if (sentAfter) params.append("DateSent>", sentAfter);
    let uri: string | null = `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json?${params.toString()}`;

    for (let page = 0; page < MAX_PAGES_PER_DIRECTION && uri; page++) {
      const data = await fetchTwilioPage(uri);
      pagesFetched++;

      const rows = (data.messages ?? [])
        .filter((message) => message.sid)
        .map((message) => ({
          direction: message.direction === "inbound" ? "inbound" : "outbound",
          from_phone: message.from,
          to_phone: message.to,
          body: message.body ?? "",
          status: message.status,
          twilio_sid: message.sid,
          created_at: new Date(message.date_sent ?? message.date_created).toISOString(),
        }));

      if (rows.length > 0) {
        const { data: inserted, error } = await db
          .from("sms_messages")
          .upsert(rows, { onConflict: "twilio_sid", ignoreDuplicates: true })
          .select("id");
        if (error) throw new Error(`Failed to store synced messages: ${error.message}`);
        imported += inserted?.length ?? 0;
      }

      uri = data.next_page_uri ?? null;
    }
  }

  return { imported, pagesFetched };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const auth = await requireStaff(req);
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  if (auth.staff.role !== "owner" && auth.staff.role !== "business_manager") {
    return json({ error: "Insufficient role" }, 403);
  }

  try {
    return json(await syncMessagesFromTwilio());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, 502);
  }
});
