import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getCurrentStaff } from "@/lib/auth";
import { listWhatsappTemplates, type WhatsappTemplate } from "@/lib/sms/twilio-content";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import {
  AddWhatsappTemplateForm,
  MessagingRules,
  type ProductOption,
  type RuleRow,
  type WaTemplateOption,
} from "./messaging-forms";

/**
 * Owner-only messaging automation: rules that run when a new booking comes in
 * ("for <product>, send <sms|whatsapp>"), plus the WhatsApp template catalog
 * (pulled live from Twilio, where Meta approval status lives).
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
        "id, name, business_tour_id, channel, body, whatsapp_content_sid, whatsapp_variables, only_first_contact, is_active",
      )
      .order("only_first_contact", { ascending: false })
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
    <div className="space-y-10">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Messaging</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Automatic messages customers receive, written as simple rules.
        </p>
      </div>

      <section className="space-y-4">
        <div>
          <h2 className="text-base font-semibold">Rules</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Each rule runs when a new booking comes in. Point it at one product or
            all of them, pick SMS or WhatsApp, and write the message. Placeholders
            fill in the real customer and booking details when the message is sent.
          </p>
        </div>
        {rulesResult.error ? (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            Could not load rules: {rulesResult.error.message}
          </p>
        ) : (
          <MessagingRules rules={rules} products={products} waTemplates={waOptions} />
        )}
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-base font-semibold">WhatsApp templates</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            WhatsApp only allows pre-approved templates for business-initiated
            messages. This list comes straight from Twilio, including each
            template&apos;s approval status. Approved templates can be used in the
            rules above.
          </p>
        </div>

        {whatsappError ? (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            Could not load WhatsApp templates: {whatsappError}
          </p>
        ) : whatsappTemplates.length === 0 ? (
          <p className="rounded-md border border-dashed bg-muted/30 px-3 py-3 text-sm text-muted-foreground">
            No WhatsApp templates yet. Add the first one below.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {whatsappTemplates.map((template) => (
              <li key={template.sid} className="flex items-start justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{template.name}</p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                    {template.body}
                  </p>
                  {template.rejectionReason ? (
                    <p className="mt-1 text-xs text-red-600">
                      Rejected: {template.rejectionReason}
                    </p>
                  ) : null}
                </div>
                <span
                  className={`mt-0.5 shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    template.status === "approved"
                      ? "bg-emerald-100 text-emerald-800"
                      : template.status === "rejected"
                        ? "bg-red-100 text-red-700"
                        : template.status === "pending"
                          ? "bg-amber-100 text-amber-800"
                          : "bg-muted text-muted-foreground"
                  }`}
                >
                  {template.status}
                </span>
              </li>
            ))}
          </ul>
        )}

        <AddWhatsappTemplateForm />
      </section>
    </div>
  );
}
