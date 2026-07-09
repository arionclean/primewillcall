import { getTwilioCredentials } from "@/lib/sms/twilio";

/**
 * Twilio Content API client for WhatsApp templates. Twilio (not our DB) is
 * the source of truth: WhatsApp business-initiated messages require Meta
 * approval, and the approval status lives on the Content resource.
 */
const CONTENT_API = "https://content.twilio.com/v1";

export type WhatsappTemplateStatus =
  | "approved"
  | "pending"
  | "rejected"
  | "draft"
  | string;

export interface WhatsappTemplate {
  sid: string;
  name: string;
  language: string;
  body: string;
  status: WhatsappTemplateStatus;
  category: string | null;
  rejectionReason: string | null;
  dateCreated: string;
}

function authHeader(): string {
  const { accountSid, authToken } = getTwilioCredentials();
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`;
}

interface ContentAndApprovalItem {
  sid: string;
  friendly_name: string;
  language: string;
  date_created: string;
  types: Record<string, { body?: string }>;
  approval_requests?: {
    status?: string;
    category?: string;
    rejection_reason?: string;
  } | null;
}

function normalizeStatus(raw: string | undefined): WhatsappTemplateStatus {
  if (!raw || raw === "unsubmitted") return "draft";
  if (raw === "received" || raw === "submitted" || raw === "pending") return "pending";
  return raw;
}

export async function listWhatsappTemplates(): Promise<WhatsappTemplate[]> {
  const response = await fetch(`${CONTENT_API}/ContentAndApprovals?PageSize=100`, {
    headers: { Authorization: authHeader() },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Twilio Content API failed with status ${response.status}`);
  }
  const data = (await response.json()) as { contents?: ContentAndApprovalItem[] };

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
 * `name` must be lowercase letters, numbers, and underscores (Meta rule);
 * the body can use numbered variables like {{1}}.
 */
export async function createWhatsappTemplate(input: {
  name: string;
  body: string;
  category: "UTILITY" | "MARKETING";
}): Promise<{ sid: string }> {
  const createResponse = await fetch(`${CONTENT_API}/Content`, {
    method: "POST",
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({
      friendly_name: input.name,
      language: "en",
      types: { "twilio/text": { body: input.body } },
    }),
  });
  const created = (await createResponse.json()) as { sid?: string; message?: string };
  if (!createResponse.ok || !created.sid) {
    throw new Error(created.message ?? `Could not create the template (${createResponse.status})`);
  }

  const approvalResponse = await fetch(
    `${CONTENT_API}/Content/${created.sid}/ApprovalRequests/whatsapp`,
    {
      method: "POST",
      headers: { Authorization: authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: input.name, category: input.category }),
    },
  );
  if (!approvalResponse.ok) {
    const failure = (await approvalResponse.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(
      failure?.message ??
        `Template created but the approval submission failed (${approvalResponse.status})`,
    );
  }

  return { sid: created.sid };
}
