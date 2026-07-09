import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizeUsPhone } from "@/lib/sms/format";
import { sendSms, type SendSmsResult } from "@/lib/sms/messages";
import { sendWhatsappTemplateMessage } from "@/lib/sms/whatsapp";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * Messaging rules engine: "when a new booking comes in for <product>, send
 * <sms|whatsapp>". Rules are owner-edited in /admin/messaging and stored in
 * messaging_rules. Bodies use {{placeholders}}; WhatsApp rules reference an
 * approved Twilio Content template plus a {{1}} -> placeholder mapping.
 */

export const RULE_PLACEHOLDERS = [
  "first_name",
  "product_name",
  "booking_link",
  "booking_date",
] as const;

export interface MessagingRule {
  id: string;
  name: string;
  trigger_event: string;
  business_tour_id: string | null;
  channel: "sms" | "whatsapp";
  body: string | null;
  whatsapp_content_sid: string | null;
  whatsapp_variables: Record<string, string> | null;
  only_first_contact: boolean;
  is_active: boolean;
}

export interface NewBookingContext {
  phone: string;
  firstName: string;
  productName: string;
  confirmationId: string;
  bookingDate?: string;
  businessTourId?: string | null;
  businessId?: string | null;
  bookingId?: string | null;
  customerId?: string | null;
}

/** Replace known {{placeholders}}; unknown ones are left visible on purpose. */
export function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, name: string) => {
    const value = vars[name.toLowerCase()];
    return value !== undefined ? value : match;
  });
}

function getDb(): SupabaseClient | null {
  // Untyped: messaging_rules is newer than the generated Database types.
  return getSupabaseAdminClient() as unknown as SupabaseClient | null;
}

export interface RuleRunResult extends SendSmsResult {
  rule: string;
}

/**
 * Run every active new-booking rule that matches the booking's product.
 * Call this after creating a booking.
 */
export async function runNewBookingRules(ctx: NewBookingContext): Promise<RuleRunResult[]> {
  const db = getDb();
  if (!db) {
    return [
      { rule: "*", sent: false, status: "failed", reason: "SUPABASE_SERVICE_ROLE_KEY not configured" },
    ];
  }
  const to = normalizeUsPhone(ctx.phone);
  if (!to) {
    return [
      { rule: "*", sent: false, status: "skipped", reason: "Only US phone numbers are supported" },
    ];
  }

  let query = db
    .from("messaging_rules")
    .select(
      "id, name, trigger_event, business_tour_id, channel, body, whatsapp_content_sid, whatsapp_variables, only_first_contact, is_active",
    )
    .eq("trigger_event", "new_booking")
    .eq("is_active", true)
    .order("only_first_contact", { ascending: false })
    .order("created_at", { ascending: true });
  query = ctx.businessTourId
    ? query.or(`business_tour_id.is.null,business_tour_id.eq.${ctx.businessTourId}`)
    : query.is("business_tour_id", null);

  const { data, error } = await query;
  if (error) {
    return [{ rule: "*", sent: false, status: "failed", reason: error.message }];
  }
  const rules = (data ?? []) as MessagingRule[];
  if (rules.length === 0) {
    return [];
  }

  // One lookup shared by every "only first contact" rule.
  let hasPriorMessages: boolean | null = null;
  if (rules.some((rule) => rule.only_first_contact)) {
    const { count } = await db
      .from("sms_messages")
      .select("id", { count: "exact", head: true })
      .eq("to_phone", to);
    hasPriorMessages = (count ?? 0) > 0;
  }

  const bookingLinkBase = process.env.BOOKING_LINK_BASE_URL ?? "https://bked.io/booking";
  const vars: Record<string, string> = {
    first_name: ctx.firstName,
    product_name: ctx.productName,
    booking_link: `${bookingLinkBase}/${ctx.confirmationId}`,
    booking_date: ctx.bookingDate ?? "",
  };
  const linkFields = {
    businessId: ctx.businessId ?? null,
    bookingId: ctx.bookingId ?? null,
    customerId: ctx.customerId ?? null,
  };

  const results: RuleRunResult[] = [];
  for (const rule of rules) {
    if (rule.only_first_contact && hasPriorMessages) {
      results.push({ rule: rule.name, sent: false, status: "skipped", reason: "Not the first contact" });
      continue;
    }

    if (rule.channel === "sms") {
      const result = await sendSms({
        to,
        body: renderTemplate(rule.body ?? "", vars),
        tag: rule.only_first_contact ? "optIn" : "bookingConfirmation",
        businessId: linkFields.businessId,
        bookingId: linkFields.bookingId,
      });
      results.push({ rule: rule.name, ...result });
    } else {
      const contentVariables: Record<string, string> = {};
      for (const [slot, placeholder] of Object.entries(rule.whatsapp_variables ?? {})) {
        contentVariables[slot] = vars[placeholder] ?? "";
      }
      const result = await sendWhatsappTemplateMessage({
        to,
        contentSid: rule.whatsapp_content_sid ?? "",
        contentVariables,
        ...linkFields,
      });
      results.push({ rule: rule.name, ...result });
    }
  }
  return results;
}
