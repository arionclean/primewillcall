"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createWhatsappTemplate } from "@/lib/sms/twilio-content";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export type MessagingActionState = {
  error?: string;
  saved?: true;
};

/** Triggers the engine can actually fire on today. New ones need engine work. */
const ALLOWED_TRIGGERS = new Set(["new_booking"]);

function readTrigger(formData: FormData): string {
  const value = String(formData.get("trigger_event") ?? "new_booking").trim();
  return ALLOWED_TRIGGERS.has(value) ? value : "new_booking";
}

async function requireOwner(): Promise<
  { ok: true; supabase: SupabaseClient } | { ok: false; error: string }
> {
  const supabase = (await getSupabaseServerClient()) as unknown as SupabaseClient;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data: current } = await supabase
    .from("staff")
    .select("role, is_active")
    .eq("user_id", user.id)
    .maybeSingle();
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
  const name = String(formData.get("rule_name") ?? "").trim() || "Untitled message";
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
 * Create a message inside an automation. The automation identity (trigger +
 * product) rides along as hidden fields; the message itself is authored in the
 * editor before anything touches the database, so there are no draft rows.
 */
export async function createMessageAction(
  _prev: MessagingActionState,
  formData: FormData,
): Promise<MessagingActionState> {
  const auth = await requireOwner();
  if (!auth.ok) return { error: auth.error };

  const parsed = parseMessageFields(formData);
  if (!parsed.ok) return { error: parsed.error };

  const businessTourId = String(formData.get("business_tour_id") ?? "").trim() || null;
  const { error } = await auth.supabase.from("messaging_rules").insert({
    ...parsed.fields,
    trigger_event: readTrigger(formData),
    business_tour_id: businessTourId,
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
    .select("id, trigger_event, business_tour_id, delay_minutes")
    .eq("id", id)
    .maybeSingle();
  if (!rule) return;

  // The message's siblings in send order (same trigger + product).
  const siblingsQuery = auth.supabase
    .from("messaging_rules")
    .select("id, delay_minutes")
    .eq("trigger_event", rule.trigger_event)
    .order("delay_minutes", { ascending: true })
    .order("created_at", { ascending: true });
  const { data: siblings } = await (rule.business_tour_id
    ? siblingsQuery.eq("business_tour_id", rule.business_tour_id)
    : siblingsQuery.is("business_tour_id", null));
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

/**
 * Turn a whole automation on or off in one click: flips every message in the
 * group (trigger + product). If any message is active it pauses them all;
 * otherwise it activates them all. The engine only fires active messages, so a
 * fully-paused automation simply does nothing.
 */
export async function toggleAutomationActiveAction(formData: FormData): Promise<void> {
  const auth = await requireOwner();
  if (!auth.ok) return;

  const trigger = readTrigger(formData);
  const productId = String(formData.get("automation_product") ?? "").trim() || null;

  const read = auth.supabase.from("messaging_rules").select("is_active").eq("trigger_event", trigger);
  const { data } = await (productId
    ? read.eq("business_tour_id", productId)
    : read.is("business_tour_id", null));
  const anyActive = (data ?? []).some((row) => row.is_active);

  const update = auth.supabase
    .from("messaging_rules")
    .update({ is_active: !anyActive })
    .eq("trigger_event", trigger);
  await (productId
    ? update.eq("business_tour_id", productId)
    : update.is("business_tour_id", null));

  revalidatePath("/admin/messaging");
}

/**
 * Re-point a whole automation at a different product. The automation is the
 * group of messages sharing a trigger product, so this updates every message
 * in it at once. If the new product already has an automation, they merge.
 */
export async function updateAutomationProductAction(formData: FormData): Promise<void> {
  const auth = await requireOwner();
  if (!auth.ok) return;

  const oldId = String(formData.get("automation_product_old") ?? "").trim() || null;
  const newId = String(formData.get("automation_product_new") ?? "").trim() || null;
  if (oldId === newId) return;

  // Scope to this automation's trigger so only its messages move.
  const query = auth.supabase
    .from("messaging_rules")
    .update({ business_tour_id: newId })
    .eq("trigger_event", readTrigger(formData));
  const { error } = oldId
    ? await query.eq("business_tour_id", oldId)
    : await query.is("business_tour_id", null);
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
