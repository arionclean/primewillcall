import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * Editable automation templates (message_templates table). Bodies use
 * {{placeholder}} variables. Defaults below match the seeded rows, so the
 * automation still works if a row is ever deleted.
 */
export const TEMPLATE_DEFAULTS: Record<string, string> = {
  sms_booking_intro: "Hi {{first_name}}, it's Jessi from {{product_name}}",
  sms_booking_confirmation:
    "Use this link to see your ticket and the meeting point information: {{booking_link}} (Text STOP to unsubscribe).",
};

export interface MessageTemplate {
  key: string;
  body: string;
  isActive: boolean;
}

/** Replace known {{placeholders}}; unknown ones are left visible on purpose. */
export function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, name: string) => {
    const value = vars[name.toLowerCase()];
    return value !== undefined ? value : match;
  });
}

/** Fetch several templates in one query, falling back to defaults. */
export async function getMessageTemplates(
  keys: string[],
): Promise<Record<string, MessageTemplate>> {
  const result: Record<string, MessageTemplate> = {};
  for (const key of keys) {
    result[key] = { key, body: TEMPLATE_DEFAULTS[key] ?? "", isActive: true };
  }

  // Untyped client: message_templates is newer than the generated Database types.
  const supabase = getSupabaseAdminClient() as unknown as SupabaseClient | null;
  if (!supabase) {
    return result;
  }

  const { data, error } = await supabase
    .from("message_templates")
    .select("key, body, is_active")
    .in("key", keys);
  if (error) {
    console.error("Failed to load message templates:", error.message);
    return result;
  }

  for (const row of (data ?? []) as { key: string; body: string; is_active: boolean }[]) {
    result[row.key] = { key: row.key, body: row.body, isActive: row.is_active };
  }
  return result;
}
