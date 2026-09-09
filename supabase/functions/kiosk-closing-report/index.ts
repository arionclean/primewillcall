// End-of-night closing statement, emailed.
//
// The tablet prints the paper form the desk signs, and posts the same figures here.
// The server sends the email (the Resend key never goes near a tablet) and records
// the close in kiosk_events, so "who closed kiosk3 on the 8th, and what were the
// totals" is answerable months later without the paper.
//
// Best-effort by design: the tablet does not block its Print button on this, and a
// kiosk with no closing_report_email simply prints.
//
// Body: { kiosk, business_name?, date_label, representative?, total_sales,
//         credit_sales, cash_sales, total_count, card_count, cash_count,
//         products: [{name,count,amount}], printed_at }

import { json, kioskAuthorized, resolveKiosk, serviceClient } from "../_shared/kiosk-sale.ts";
import {
  closingHtml,
  closingSubject,
  closingText,
  type ClosingReport,
} from "../_shared/closing-email.ts";
import { withSentry } from "../_shared/sentry.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
// The same verified sender the messaging cap alert uses (docs/messaging-automations.md).
const FROM = Deno.env.get("CLOSING_REPORT_FROM") ?? "alerts@alert.primewillcall.com";

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

Deno.serve(withSentry("kiosk-closing-report", async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!kioskAuthorized(req)) return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  const slug = String(body.kiosk ?? "").trim();
  if (!slug) return json({ error: "missing_kiosk" }, 400);

  const sb = serviceClient();
  const resolved = await resolveKiosk(sb, slug);
  if (!resolved) return json({ error: "unknown_kiosk" }, 404);

  // The till's own name comes from the database, never the tablet: it is the thing
  // that tells two kiosks apart on the same business, so it must not be spoofable.
  const { data: row } = await sb
    .from("kiosks")
    .select("name, closing_report_email")
    .eq("id", resolved.kiosk.id)
    .maybeSingle<{ name: string | null; closing_report_email: string | null }>();

  const rawProducts = Array.isArray(body.products) ? body.products : [];
  const report: ClosingReport = {
    kioskName: row?.name?.trim() || slug,
    kioskSlug: slug,
    businessName: String(body.business_name ?? "").trim() || "Prime",
    dateLabel: String(body.date_label ?? ""),
    representative: body.representative ? String(body.representative) : null,
    totalSales: num(body.total_sales),
    creditSales: num(body.credit_sales),
    cashSales: num(body.cash_sales),
    totalCount: Math.trunc(num(body.total_count)),
    cardCount: Math.trunc(num(body.card_count)),
    cashCount: Math.trunc(num(body.cash_count)),
    products: rawProducts.slice(0, 40).map((p) => {
      const item = p as Record<string, unknown>;
      return {
        name: String(item.name ?? "").slice(0, 80),
        count: Math.trunc(num(item.count)),
        amount: num(item.amount),
      };
    }),
    printedAt: String(body.printed_at ?? ""),
  };

  // The close is worth recording whether or not the email goes anywhere.
  await sb.from("kiosk_events").insert({
    kiosk_id: resolved.kiosk.id,
    kiosk_slug: slug,
    business_id: resolved.kiosk.business_id,
    event: "closing_report",
    level: "info",
    app_build: body.app_build ? String(body.app_build) : null,
    device_id: body.device_id ? String(body.device_id) : null,
    employee_id: body.employee_id ? String(body.employee_id) : null,
    employee_name: report.representative,
    payload: {
      total_cents: Math.round(report.totalSales * 100),
      card_cents: Math.round(report.creditSales * 100),
      cash_cents: Math.round(report.cashSales * 100),
      sales: report.totalCount,
      date: report.dateLabel,
    },
  });

  const to = row?.closing_report_email?.trim();
  if (!to) return json({ ok: true, emailed: false, reason: "no_recipient" }, 200);
  if (!RESEND_API_KEY) return json({ ok: true, emailed: false, reason: "no_key" }, 200);

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        subject: closingSubject(report),
        html: closingHtml(report),
        text: closingText(report),
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      console.error("[closing-report] resend:", res.status, detail.slice(0, 300));
      return json({ ok: true, emailed: false, reason: "send_failed" }, 200);
    }
  } catch (e) {
    console.error("[closing-report] resend threw:", e);
    return json({ ok: true, emailed: false, reason: "send_error" }, 200);
  }

  return json({ ok: true, emailed: true, to }, 200);
}));
