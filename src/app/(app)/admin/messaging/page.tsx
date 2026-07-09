import { redirect } from "next/navigation";

import { getCurrentStaff } from "@/lib/auth";
import { listWhatsappTemplates, type WhatsappTemplate } from "@/lib/sms/twilio-content";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { SmsTemplatesForm, AddWhatsappTemplateForm, type SmsTemplateRow } from "./messaging-forms";

/**
 * Owner-only config for customer messaging: the wording of the automated
 * booking SMS, and the WhatsApp template catalog (pulled live from Twilio,
 * where Meta approval status lives).
 */
export default async function MessagingConfigPage() {
  const { user, staff } = await getCurrentStaff();
  if (!user) redirect("/login?next=/admin/messaging");
  if (!staff || !staff.is_active || staff.role !== "owner") redirect("/dashboard");

  const supabase = await getSupabaseServerClient();
  const { data, error } = await (supabase as unknown as import("@supabase/supabase-js").SupabaseClient)
    .from("message_templates")
    .select("id, key, channel, label, description, body, is_active")
    .eq("channel", "sms")
    .order("key");
  const smsTemplates = ((data ?? []) as SmsTemplateRow[]).sort((a) =>
    a.key === "sms_booking_intro" ? -1 : 1,
  );

  let whatsappTemplates: WhatsappTemplate[] = [];
  let whatsappError: string | null = null;
  try {
    whatsappTemplates = await listWhatsappTemplates();
  } catch (e) {
    whatsappError = e instanceof Error ? e.message : "Could not reach Twilio.";
  }

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Messaging</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Edit the automatic texts customers receive and manage WhatsApp templates.
        </p>
      </div>

      <section className="space-y-4">
        <div>
          <h2 className="text-base font-semibold">Booking SMS automation</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            These are sent automatically when a new booking comes in. You can use the
            placeholders shown under each message; they are replaced with the real
            values when the text is sent.
          </p>
        </div>
        {error ? (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            Could not load templates: {error.message}
          </p>
        ) : (
          <SmsTemplatesForm rows={smsTemplates} />
        )}
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-base font-semibold">WhatsApp templates</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            WhatsApp only allows pre-approved templates for business-initiated
            messages. This list comes straight from Twilio, including each
            template&apos;s approval status. New templates are usually reviewed by
            WhatsApp within minutes to a few hours.
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
