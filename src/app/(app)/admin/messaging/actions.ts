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

/**
 * Save the automation SMS bodies. Each template is sent as tpl_id_${i},
 * tpl_body_${i}, tpl_active_${i} ("1" when enabled). Writes run as the
 * signed-in user; RLS enforces owner-only on top of the check here.
 */
export async function updateSmsTemplatesAction(
  _prev: MessagingActionState,
  formData: FormData,
): Promise<MessagingActionState> {
  const auth = await requireOwner();
  if (!auth.ok) return { error: auth.error };

  for (let i = 0; i < 20; i++) {
    const id = String(formData.get(`tpl_id_${i}`) ?? "").trim();
    if (!id) continue;
    const body = String(formData.get(`tpl_body_${i}`) ?? "").trim();
    if (!body) return { error: "A message cannot be empty." };
    const isActive = formData.get(`tpl_active_${i}`) === "1";

    const { error } = await auth.supabase
      .from("message_templates")
      .update({ body, is_active: isActive })
      .eq("id", id);
    if (error) return { error: `Could not save: ${error.message}` };
  }

  revalidatePath("/admin/messaging");
  return { saved: true };
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
