import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";

import { Badge } from "@/components/ui/badge";
import { getCurrentStaff } from "@/lib/auth";
import { listWhatsappTemplates, type WhatsappTemplate } from "@/lib/sms/twilio-content";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { AddWhatsappTemplateForm, MessagingRules } from "./messaging-forms";
import type { ProductOption, RuleRow, WaTemplateOption } from "./messaging-lib";
import { MessagingTabs } from "./messaging-tabs";

const STATUS_TONE: Record<string, "success" | "warning" | "danger"> = {
  approved: "success",
  pending: "warning",
  rejected: "danger",
};

/**
 * Owner-only automations: trigger (new booking, per product) -> actions
 * (SMS / WhatsApp messages, each optionally delayed), plus the WhatsApp
 * template catalog (pulled live from Twilio, where Meta approval lives).
 */
export default async function MessagingConfigPage() {
  const { user, staff } = await getCurrentStaff();
  if (!user) redirect("/login?next=/admin/messaging");
  if (!staff || !staff.is_active || staff.role !== "owner") redirect("/dashboard");

  const supabase = (await getSupabaseServerClient()) as unknown as SupabaseClient;

  const [rulesResult, productsResult] = await Promise.all([
    supabase
      .from("messaging_rules")
      .select(
        "id, name, trigger_event, business_tour_id, channel, body, whatsapp_content_sid, whatsapp_variables, only_first_contact, is_active, delay_minutes",
      )
      .order("created_at", { ascending: true }),
    supabase
      .from("business_tours")
      .select("id, name, business:businesses!business_tours_business_id_fkey(name)")
      .eq("is_active", true)
      .order("name"),
  ]);

  const rules = (rulesResult.data ?? []) as RuleRow[];
  type ProductJoined = { id: string; name: string; business: { name: string } | null };
  const products = ((productsResult.data ?? []) as unknown as ProductJoined[]).map<ProductOption>(
    (row) => ({
      id: row.id,
      name: row.name,
      businessName: row.business?.name ?? "Unknown business",
    }),
  );

  let whatsappTemplates: WhatsappTemplate[] = [];
  let whatsappError: string | null = null;
  try {
    whatsappTemplates = await listWhatsappTemplates();
  } catch (e) {
    whatsappError = e instanceof Error ? e.message : "Could not reach Twilio.";
  }
  const waOptions: WaTemplateOption[] = whatsappTemplates.map((template) => ({
    sid: template.sid,
    name: template.name,
    body: template.body,
    status: template.status,
  }));

  return (
    <div className="max-w-3xl">
      <h1 className="mb-6 text-xl font-semibold tracking-tight">Automations</h1>

      <MessagingTabs
        templateCount={whatsappError ? 0 : whatsappTemplates.length}
        automations={
          rulesResult.error ? (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              Could not load automations: {rulesResult.error.message}
            </p>
          ) : (
            <MessagingRules rules={rules} products={products} waTemplates={waOptions} />
          )
        }
        templates={
          <section className="space-y-3">
            {whatsappError ? (
              <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                Could not load WhatsApp templates: {whatsappError}
              </p>
            ) : whatsappTemplates.length === 0 ? (
              <p className="rounded-md border border-dashed bg-muted/30 px-3 py-3 text-sm text-muted-foreground">
                No WhatsApp templates yet. Add the first one below.
              </p>
            ) : (
              <ul className="space-y-2">
                {whatsappTemplates.map((template) => (
                  <li
                    key={template.sid}
                    className="rounded-xl border bg-card px-4 py-3 shadow-sm"
                  >
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">{template.name}</p>
                      <Badge tone={STATUS_TONE[template.status] ?? "neutral"}>
                        {template.status}
                      </Badge>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {template.body}
                    </p>
                    {template.rejectionReason ? (
                      <p className="mt-0.5 text-xs text-red-600">
                        Rejected: {template.rejectionReason}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            <AddWhatsappTemplateForm />
          </section>
        }
      />
    </div>
  );
}
