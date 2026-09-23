"use server";

import { revalidatePath } from "next/cache";

import { getCurrentStaff } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export type MailroomActionState = { error?: string; saved?: boolean };

async function isOwner(): Promise<boolean> {
  const { staff } = await getCurrentStaff();
  return Boolean(staff && staff.is_active && staff.role === "owner");
}

/**
 * Send an email round again. The database function re-checks the owner, resets only
 * the processing state (never the email itself) and kicks the sweep, so the result
 * lands on the screen in seconds over Realtime.
 */
export async function retryEmail(
  _prev: MailroomActionState,
  formData: FormData,
): Promise<MailroomActionState> {
  if (!(await isOwner())) return { error: "Only the owner can do this." };
  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "Missing email." };

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.rpc("mailroom_retry", { p_email_id: id });
  if (error) return { error: error.message };
  revalidatePath("/admin/mailroom");
  return { saved: true };
}

/** Take an email off the Mailroom's hands (junk, or a guest already booked by hand). */
export async function setAsideEmail(
  _prev: MailroomActionState,
  formData: FormData,
): Promise<MailroomActionState> {
  if (!(await isOwner())) return { error: "Only the owner can do this." };
  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "Missing email." };

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.rpc("mailroom_set_aside", { p_email_id: id });
  if (error) return { error: error.message };
  revalidatePath("/admin/mailroom");
  return { saved: true };
}

/**
 * The email as the reader saw it. Loaded on demand: fifty full emails would make the
 * list heavy for the one or two anyone opens.
 */
export async function loadEmailText(id: string): Promise<string | null> {
  if (!(await isOwner())) return null;
  const supabase = await getSupabaseServerClient();
  const { data } = await supabase
    .from("inbound_emails")
    .select("raw_text")
    .eq("id", id)
    .maybeSingle();
  return data?.raw_text ?? null;
}
