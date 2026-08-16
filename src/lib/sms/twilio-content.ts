import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * WhatsApp template catalog, read through the `whatsapp-templates` edge function.
 *
 * Twilio (not our DB) is the source of truth: business-initiated WhatsApp messages
 * require Meta approval, and the approval status lives on the Content resource.
 * The Twilio call itself happens in Supabase, so the credentials stay function
 * secrets; this module only carries the request there as the signed-in staff user.
 */

export type WhatsappTemplateStatus = "approved" | "pending" | "rejected" | "draft" | string;

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

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const supabase = (await getSupabaseServerClient()) as unknown as SupabaseClient;
  const { data, error } = await supabase.functions.invoke<T & { error?: string }>(
    "whatsapp-templates",
    { body },
  );
  // A non-2xx from the function surfaces as error with the body attached, so read
  // our own message out of it rather than showing "Edge Function returned 4xx".
  if (error) {
    const detail = await readErrorMessage(error);
    throw new Error(detail ?? error.message);
  }
  if (data && typeof data === "object" && "error" in data && data.error) {
    throw new Error(String(data.error));
  }
  return data as T;
}

/** supabase-js wraps the failing Response; the useful message is inside its body. */
async function readErrorMessage(error: unknown): Promise<string | null> {
  const context = (error as { context?: Response }).context;
  if (!context || typeof context.json !== "function") return null;
  try {
    const parsed = (await context.json()) as { error?: string };
    return parsed?.error ?? null;
  } catch {
    return null;
  }
}

export async function listWhatsappTemplates(): Promise<WhatsappTemplate[]> {
  const data = await invoke<{ templates: WhatsappTemplate[] }>({ action: "list" });
  return data.templates ?? [];
}

/**
 * Create a text template and submit it for WhatsApp approval.
 * The name is normalized to Meta's rule (lowercase, numbers, underscores) inside
 * the function; the body can use numbered variables like {{1}}.
 */
export async function createWhatsappTemplate(input: {
  name: string;
  body: string;
  category: "UTILITY" | "MARKETING";
}): Promise<{ sid: string }> {
  return invoke<{ sid: string }>({ action: "create", ...input });
}
