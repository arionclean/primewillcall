// WhatsApp template catalog: list the templates and submit new ones for Meta
// approval. Supabase-native replacement for src/lib/sms/twilio-content.ts, so the
// Twilio credentials stay function secrets and Vercel never holds them.
//
// Twilio (not our DB) is the source of truth here: business-initiated WhatsApp
// requires Meta approval, and the approval status lives on the Content resource.
//
// Deployed with JWT ON. Listing is open to any active staff member; creating a
// template is owner-only, because an approval submission is a change to Prime's
// WhatsApp sender that every business shares.
//
//   GET  (or POST {action:"list"})    -> { templates: [...] }
//   POST {action:"create", name, body, category} -> { sid }
//
// Secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN.

import { corsHeaders, json, twilioAuthHeader } from "../_shared/sms.ts";
import { requireStaff } from "../_shared/staff-auth.ts";

const CONTENT_API = "https://content.twilio.com/v1";

interface ContentAndApprovalItem {
  sid: string;
  friendly_name: string;
  language: string;
  date_created: string;
  types: Record<string, { body?: string }>;
  approval_requests?: { status?: string; category?: string; rejection_reason?: string } | null;
}

/** Twilio reports several in-flight states; the UI only needs four. */
function normalizeStatus(raw: string | undefined): string {
  if (!raw || raw === "unsubmitted") return "draft";
  if (raw === "received" || raw === "submitted" || raw === "pending") return "pending";
  return raw;
}

async function listTemplates() {
  const response = await fetch(`${CONTENT_API}/ContentAndApprovals?PageSize=100`, {
    headers: { Authorization: twilioAuthHeader() },
  });
  if (!response.ok) throw new Error(`Twilio Content API failed with status ${response.status}`);
  const data = await response.json() as { contents?: ContentAndApprovalItem[] };

  return (data.contents ?? [])
    .map((item) => {
      const firstType = Object.values(item.types ?? {})[0];
      return {
        sid: item.sid,
        name: item.friendly_name,
        language: item.language,
        body: firstType?.body ?? "",
        status: normalizeStatus(item.approval_requests?.status),
        category: item.approval_requests?.category ?? null,
        rejectionReason: item.approval_requests?.rejection_reason || null,
        dateCreated: item.date_created,
      };
    })
    .sort((a, b) => (a.dateCreated < b.dateCreated ? 1 : -1));
}

/**
 * Create a text template and submit it for WhatsApp approval in one step.
 * `name` must be lowercase letters, numbers and underscores (Meta's rule); the
 * body can use numbered variables like {{1}}.
 */
async function createTemplate(input: { name: string; body: string; category: string }) {
  const createResponse = await fetch(`${CONTENT_API}/Content`, {
    method: "POST",
    headers: { Authorization: twilioAuthHeader(), "content-type": "application/json" },
    body: JSON.stringify({
      friendly_name: input.name,
      language: "en",
      types: { "twilio/text": { body: input.body } },
    }),
  });
  const created = await createResponse.json() as { sid?: string; message?: string };
  if (!createResponse.ok || !created.sid) {
    throw new Error(created.message ?? `Could not create the template (${createResponse.status})`);
  }

  const approvalResponse = await fetch(
    `${CONTENT_API}/Content/${created.sid}/ApprovalRequests/whatsapp`,
    {
      method: "POST",
      headers: { Authorization: twilioAuthHeader(), "content-type": "application/json" },
      body: JSON.stringify({ name: input.name, category: input.category }),
    },
  );
  if (!approvalResponse.ok) {
    const failure = await approvalResponse.json().catch(() => null) as { message?: string } | null;
    throw new Error(
      failure?.message ??
        `Template created but the approval submission failed (${approvalResponse.status})`,
    );
  }

  return { sid: created.sid };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const auth = await requireStaff(req);
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  let action = "list";
  let payload: { name?: string; body?: string; category?: string } = {};
  if (req.method === "POST") {
    try {
      const parsed = await req.json() as typeof payload & { action?: string };
      action = parsed.action ?? "list";
      payload = parsed;
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
  }

  try {
    if (action === "list") {
      return json({ templates: await listTemplates() });
    }

    if (action === "create") {
      if (auth.staff.role !== "owner") return json({ error: "Owner only" }, 403);

      const name = (payload.name ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
      const body = (payload.body ?? "").trim();
      const category = payload.category ?? "UTILITY";
      if (!name) return json({ error: "Give the template a name." }, 400);
      if (!body) return json({ error: "Write the message text." }, 400);
      if (category !== "UTILITY" && category !== "MARKETING") {
        return json({ error: "Pick a valid category." }, 400);
      }

      return json(await createTemplate({ name, body, category }));
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 502);
  }
});
