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

/**
 * Add a draft message with sensible defaults; the owner edits it in place.
 * A message belongs to one automation, identified by its trigger product
 * (`business_tour_id`, blank = any product). "Add message" reuses the
 * automation's product; "Add automation" passes the newly chosen product.
 */
export async function createRuleAction(formData: FormData): Promise<void> {
  const auth = await requireOwner();
  if (!auth.ok) return;

  const businessTourId = String(formData.get("business_tour_id") ?? "").trim() || null;

  await auth.supabase.from("messaging_rules").insert({
    name: "New message",
    trigger_event: readTrigger(formData),
    business_tour_id: businessTourId,
    channel: "sms",
    body: "Hi {{first_name}}!",
    is_active: false,
  });
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

/** Save one rule card. Field names match messaging-forms.tsx. */
export async function updateRuleAction(
  _prev: MessagingActionState,
  formData: FormData,
): Promise<MessagingActionState> {
  const auth = await requireOwner();
  if (!auth.ok) return { error: auth.error };

  const id = String(formData.get("rule_id") ?? "").trim();
  if (!id) return { error: "Missing rule id." };

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

  if (channel !== "sms" && channel !== "whatsapp") return { error: "Pick a channel." };
  if (channel === "sms" && !body) return { error: "Write the text message." };
  if (channel === "whatsapp" && !contentSid) {
    return { error: "Pick an approved WhatsApp template." };
  }

  const whatsappVariables: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    const match = key.match(/^wa_var_(\d+)$/);
    if (match && typeof value === "string" && value) {
      whatsappVariables[match[1]] = value;
    }
  }

  const { error } = await auth.supabase
    .from("messaging_rules")
    .update({
      name,
      channel,
      body: channel === "sms" ? body : null,
      whatsapp_content_sid: channel === "whatsapp" ? contentSid : null,
      whatsapp_variables: channel === "whatsapp" ? whatsappVariables : null,
      only_first_contact: onlyFirstContact,
      is_active: isActive,
      delay_minutes: delayMinutes,
    })
    .eq("id", id);
  if (error) return { error: `Could not save: ${error.message}` };

  revalidatePath("/admin/messaging");
  return { saved: true };
}

export async function deleteRuleAction(formData: FormData): Promise<void> {
  const auth = await requireOwner();
  if (!auth.ok) return;

  const id = String(formData.get("rule_id") ?? "").trim();
  if (!id) return;
  await auth.supabase.from("messaging_rules").delete().eq("id", id);
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
