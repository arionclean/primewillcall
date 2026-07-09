"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createWhatsappTemplate } from "@/lib/sms/twilio-content";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export type MessagingActionState = {
  error?: string;
  saved?: true;
};

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

/** Add a draft rule with sensible defaults; the owner edits it in place. */
export async function createRuleAction(): Promise<void> {
  const auth = await requireOwner();
  if (!auth.ok) return;

  await auth.supabase.from("messaging_rules").insert({
    name: "New rule",
    trigger_event: "new_booking",
    channel: "sms",
    body: "Hi {{first_name}}!",
    is_active: false,
  });
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

  const name = String(formData.get("rule_name") ?? "").trim() || "Untitled rule";
  const businessTourId = String(formData.get("rule_product") ?? "").trim() || null;
  const channel = String(formData.get("rule_channel") ?? "sms");
  const body = String(formData.get("rule_body") ?? "").trim();
  const contentSid = String(formData.get("rule_wa_template") ?? "").trim();
  const onlyFirstContact = formData.get("rule_first_contact") === "1";
  const isActive = formData.get("rule_active") === "1";

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
      business_tour_id: businessTourId,
      channel,
      body: channel === "sms" ? body : null,
      whatsapp_content_sid: channel === "whatsapp" ? contentSid : null,
      whatsapp_variables: channel === "whatsapp" ? whatsappVariables : null,
      only_first_contact: onlyFirstContact,
      is_active: isActive,
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
