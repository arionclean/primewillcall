"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createWhatsappTemplate } from "@/lib/sms/twilio-content";
import { getCurrentStaff } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export type MessagingActionState = {
  error?: string;
  saved?: true;
};

/**
 * Triggers the engine can actually fire on today. New ones need engine work.
 *
 * Keep in sync with TRIGGERS in messaging-lib.ts and the
 * messaging_rules_trigger_event_check constraint. Anything missing here is
 * silently rewritten to new_booking by readTrigger, so a value that reaches
 * the form but not this set becomes a live new-booking message.
 */
const ALLOWED_TRIGGERS = new Set(["new_booking", "new_booking_non_us"]);

function readTrigger(formData: FormData): string {
  const value = String(formData.get("trigger_event") ?? "new_booking").trim();
  return ALLOWED_TRIGGERS.has(value) ? value : "new_booking";
}

async function requireOwner(): Promise<
  { ok: true; supabase: SupabaseClient } | { ok: false; error: string }
> {
  const supabase = (await getSupabaseServerClient()) as unknown as SupabaseClient;

  const { user, staff: current } = await getCurrentStaff();
  if (!user) return { ok: false, error: "Not signed in." };
  if (!current || !current.is_active || current.role !== "owner") {
    return { ok: false, error: "Only the owner can change messaging settings." };
  }
  return { ok: true, supabase };
}

type MessageFields = {
  name: string;
  channel: "sms" | "whatsapp";
  body: string | null;
  whatsapp_content_sid: string | null;
  whatsapp_variables: Record<string, string> | null;
  only_first_contact: boolean;
  is_active: boolean;
  delay_minutes: number;
};

/** Read + validate the message form. Field names match message-editor.tsx. */
function parseMessageFields(
  formData: FormData,
): { ok: true; fields: MessageFields } | { ok: false; error: string } {
  const channel = String(formData.get("rule_channel") ?? "sms");
  const body = String(formData.get("rule_body") ?? "").trim();
  const contentSid = String(formData.get("rule_wa_template") ?? "").trim();
  const onlyFirstContact = formData.get("rule_first_contact") === "1";
  const isActive = formData.get("rule_active") === "1";
  // 0 = send immediately; otherwise wait this many minutes after the trigger.
  const delayMinutes = Math.min(
    43200,
    Math.max(0, Math.round(Number(formData.get("rule_delay_minutes") ?? 0) || 0)),
  );

  if (channel !== "sms" && channel !== "whatsapp") return { ok: false, error: "Pick a channel." };
  if (channel === "sms" && !body) return { ok: false, error: "Write the text message." };
  if (channel === "whatsapp" && !contentSid) {
    return { ok: false, error: "Pick an approved WhatsApp template." };
  }

  const whatsappVariables: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    const match = key.match(/^wa_var_(\d+)$/);
    if (match && typeof value === "string" && value) {
      whatsappVariables[match[1]] = value;
    }
  }

  // Messages have no user-facing name; the UI shows the message itself. Store a
  // derived label so the NOT NULL column stays populated and readable in the DB.
  const name = channel === "sms" ? body.slice(0, 60) || "Text message" : "WhatsApp message";

  return {
    ok: true,
    fields: {
      name,
      channel,
      body: channel === "sms" ? body : null,
      whatsapp_content_sid: channel === "whatsapp" ? contentSid : null,
      whatsapp_variables: channel === "whatsapp" ? whatsappVariables : null,
      only_first_contact: onlyFirstContact,
      is_active: isActive,
      delay_minutes: delayMinutes,
    },
  };
}

/**
 * Read a trigger's product set off a form. The picker posts a comma-separated
 * list of business_tour ids; empty means "any product", which is stored as NULL.
 */
function readProductIds(formData: FormData, field: string): string[] | null {
  const ids = String(formData.get(field) ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids : null;
}

/**
 * Create a message. The message is authored fully in the editor before
 * anything touches the database, so there are no draft rows.
 *
 * `automation_id` decides which automation it joins: pass an existing id to add
 * an action to that automation, or omit it to start a brand-new automation (the
 * column default mints a fresh id). This is what lets two automations share a
 * trigger and product without merging.
 */
export async function createMessageAction(
  _prev: MessagingActionState,
  formData: FormData,
): Promise<MessagingActionState> {
  const auth = await requireOwner();
  if (!auth.ok) return { error: auth.error };

  const parsed = parseMessageFields(formData);
  if (!parsed.ok) return { error: parsed.error };

  const businessTourIds = readProductIds(formData, "business_tour_ids");
  const automationId = String(formData.get("automation_id") ?? "").trim();
  const { error } = await auth.supabase.from("messaging_rules").insert({
    ...parsed.fields,
    trigger_event: readTrigger(formData),
    business_tour_ids: businessTourIds,
    ...(automationId ? { automation_id: automationId } : {}),
  });
  if (error) return { error: `Could not save: ${error.message}` };

  revalidatePath("/admin/messaging");
  return { saved: true };
}

/** Save one message. `rule_id` rides along as a hidden field. */
export async function updateRuleAction(
  _prev: MessagingActionState,
  formData: FormData,
): Promise<MessagingActionState> {
  const auth = await requireOwner();
  if (!auth.ok) return { error: auth.error };

  const id = String(formData.get("rule_id") ?? "").trim();
  if (!id) return { error: "Missing message id." };

  const parsed = parseMessageFields(formData);
  if (!parsed.ok) return { error: parsed.error };

  const { error } = await auth.supabase
    .from("messaging_rules")
    .update(parsed.fields)
    .eq("id", id);
  if (error) return { error: `Could not save: ${error.message}` };

  revalidatePath("/admin/messaging");
  return { saved: true };
}

/**
 * Save a Wait node. The automation is a sequence: a wait is the GAP between
 * the previous step and this message, so changing it shifts this message and
 * every step after it by the same amount. 0 removes the wait. The database
 * still stores each message's absolute delay from the trigger (that is what
 * the send queue schedules on); this action does the gap-to-absolute math.
 */
export async function updateWaitGapAction(formData: FormData): Promise<void> {
  const auth = await requireOwner();
  if (!auth.ok) return;

  const id = String(formData.get("rule_id") ?? "").trim();
  if (!id) return;
  const gap = Math.min(
    43200,
    Math.max(0, Math.round(Number(formData.get("wait_gap_minutes") ?? 0) || 0)),
  );

  const { data: rule } = await auth.supabase
    .from("messaging_rules")
    .select("id, automation_id, delay_minutes")
    .eq("id", id)
    .maybeSingle();
  if (!rule) return;

  // The message's siblings in send order (same automation).
  const { data: siblings } = await auth.supabase
    .from("messaging_rules")
    .select("id, delay_minutes")
    .eq("automation_id", rule.automation_id)
    .order("delay_minutes", { ascending: true })
    .order("created_at", { ascending: true });
  const steps = siblings ?? [];

  const index = steps.findIndex((step) => step.id === id);
  if (index < 0) return;
  const prevDelay = index > 0 ? steps[index - 1].delay_minutes : 0;
  const delta = gap - (rule.delay_minutes - prevDelay);
  if (delta === 0) return;

  // Shift this step and everything after it, keeping their gaps intact.
  for (const step of steps.slice(index)) {
    const next = Math.min(43200, Math.max(0, step.delay_minutes + delta));
    await auth.supabase
      .from("messaging_rules")
      .update({ delay_minutes: next })
      .eq("id", step.id);
  }
  revalidatePath("/admin/messaging");
}

export async function deleteRuleAction(formData: FormData): Promise<void> {
  const auth = await requireOwner();
  if (!auth.ok) return;

  const id = String(formData.get("rule_id") ?? "").trim();
  if (!id) return;
  await auth.supabase.from("messaging_rules").delete().eq("id", id);
  revalidatePath("/admin/messaging");
}

/** Delete a whole automation: every message sharing this `automation_id`. */
export async function deleteAutomationAction(formData: FormData): Promise<void> {
  const auth = await requireOwner();
  if (!auth.ok) return;

  const automationId = String(formData.get("automation_id") ?? "").trim();
  if (!automationId) return;
  await auth.supabase.from("messaging_rules").delete().eq("automation_id", automationId);
  revalidatePath("/admin/messaging");
}

/**
 * Turn a whole automation on or off in one click: flips every message in it. If
 * any message is active it pauses them all; otherwise it activates them all. The
 * engine only fires active messages, so a fully-paused automation does nothing.
 */
export async function toggleAutomationActiveAction(formData: FormData): Promise<void> {
  const auth = await requireOwner();
  if (!auth.ok) return;

  const automationId = String(formData.get("automation_id") ?? "").trim();
  if (!automationId) return;

  const { data } = await auth.supabase
    .from("messaging_rules")
    .select("is_active")
    .eq("automation_id", automationId);
  const anyActive = (data ?? []).some((row) => row.is_active);

  await auth.supabase
    .from("messaging_rules")
    .update({ is_active: !anyActive })
    .eq("automation_id", automationId);

  revalidatePath("/admin/messaging");
}

/**
 * Re-point a whole automation at a different set of products. Every message in
 * the automation moves together. An empty set means "any product". Automations are keyed by `automation_id`, so this
 * never merges two automations that happen to land on the same product.
 */
export async function updateAutomationProductAction(formData: FormData): Promise<void> {
  const auth = await requireOwner();
  if (!auth.ok) return;

  const automationId = String(formData.get("automation_id") ?? "").trim();
  if (!automationId) return;
  const newIds = readProductIds(formData, "automation_product_new");

  const { error } = await auth.supabase
    .from("messaging_rules")
    .update({ business_tour_ids: newIds })
    .eq("automation_id", automationId);
  if (error) return;

  revalidatePath("/admin/messaging");
}

/**
 * Move a whole automation onto a different trigger.
 *
 * Scoped by `automation_id`, like the product picker, so every message in the
 * sequence moves together: a trigger belongs to the automation, not to the
 * individual message rows that store a copy of it.
 */
export async function updateAutomationTriggerAction(formData: FormData): Promise<void> {
  const auth = await requireOwner();
  if (!auth.ok) return;

  const automationId = String(formData.get("automation_id") ?? "").trim();
  if (!automationId) return;

  const { error } = await auth.supabase
    .from("messaging_rules")
    .update({ trigger_event: readTrigger(formData) })
    .eq("automation_id", automationId);
  if (error) return;

  revalidatePath("/admin/messaging");
}

/** Create a WhatsApp text template in Twilio and submit it for Meta approval. */
export async function createWhatsappTemplateAction(
  _prev: MessagingActionState,
  formData: FormData,
): Promise<MessagingActionState> {
  const auth = await requireOwner();
  if (!auth.ok) return { error: auth.error };

  const rawName = String(formData.get("wa_name") ?? "").trim();
  const body = String(formData.get("wa_body") ?? "").trim();
  const category = String(formData.get("wa_category") ?? "UTILITY");

  const name = rawName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!name) return { error: "Give the template a name." };
  if (!body) return { error: "Write the message text." };
  if (category !== "UTILITY" && category !== "MARKETING") {
    return { error: "Pick a valid category." };
  }

  try {
    await createWhatsappTemplate({ name, body, category });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not create the template." };
  }

  revalidatePath("/admin/messaging");
  return { saved: true };
}
