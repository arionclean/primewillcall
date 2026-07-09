import { getTwilioCredentials, getTwilioFromNumber } from "@/lib/sms/twilio";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

const TWILIO_HOST = "https://api.twilio.com";
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
  const { accountSid, authToken } = getTwilioCredentials();
  const response = await fetch(`${TWILIO_HOST}${uri}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Twilio message list failed with status ${response.status}`);
  }
  return (await response.json()) as TwilioMessagesPage;
}

/**
 * Pull message history from the Twilio Messages API into sms_messages.
 * Twilio is the shared source of truth while Xano coexists: messages Xano
 * sends (booking confirmations, campaigns) only reach our log through here.
 * Incremental: only fetches messages sent after our latest logged row
 * (with a 1-day overlap), deduped by twilio_sid.
 */
export async function syncMessagesFromTwilio(): Promise<{ imported: number; pagesFetched: number }> {
  const supabase = getSupabaseAdminClient();
  const { accountSid } = getTwilioCredentials();
  const ourNumber = getTwilioFromNumber();

  const { data: latest } = await supabase
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
    if (sentAfter) {
      params.append("DateSent>", sentAfter);
    }
    let uri: string | null =
      `/2010-04-01/Accounts/${accountSid}/Messages.json?${params.toString()}`;

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
        const { data: inserted, error } = await supabase
          .from("sms_messages")
          .upsert(rows, { onConflict: "twilio_sid", ignoreDuplicates: true })
          .select("id");
        if (error) {
          throw new Error(`Failed to store synced messages: ${error.message}`);
        }
        imported += inserted?.length ?? 0;
      }

      uri = data.next_page_uri ?? null;
    }
  }

  return { imported, pagesFetched };
}
