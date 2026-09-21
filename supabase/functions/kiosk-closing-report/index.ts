// End-of-night closing statement: recorded, then emailed.
//
// The tablet prints the paper form the desk signs, and posts the same figures here.
// The server records the close in `kiosk_closings` (one row per kiosk per business
// day, the durable record), logs it to kiosk_events as it always has, and sends the
// email (the Resend key never goes near a tablet).
//
// The row comes FIRST, before the email is attempted, because the close is the
// record and the email is only a copy of it. A night whose email bounces is still
// a night that was counted and whose commission left the till.
//
// Best-effort by design: the tablet does not block its Print button on this, and a
// kiosk with no closing_report_email simply prints.
//
// Body: { kiosk, business_name?, date_label, business_date?, representative?,
//         total_sales, credit_sales, cash_sales, total_count, card_count,
//         cash_count, commission?, products: [{name,count,amount}], printed_at }
// `commission` (dollars) is what staff typed at close, from build 21. Without it the
// email reads as it always has; with it, Commission and Total Cash appear too.

import { json, kioskAuthorized, resolveKiosk, serviceClient } from "../_shared/kiosk-sale.ts";
import {
  closingHtml,
  closingSubject,
  closingText,
  type ClosingReport,
} from "../_shared/closing-email.ts";
import { nyNow } from "../_shared/ny-time.ts";
import { withSentry } from "../_shared/sentry.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
// The same verified sender the messaging cap alert uses (docs/messaging-automations.md).
const FROM = Deno.env.get("CLOSING_REPORT_FROM") ?? "alerts@alert.primewillcall.com";

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** The commission typed at close, in dollars, or null when the tablet sent none. */
const commissionOf = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return UUID_RE.test(s) ? s : null;
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The business day this close reports on, as YYYY-MM-DD.
 *
 * Never the clock at the moment the tablet posted: kiosk3 closes after 8pm ET and
 * kiosk1 sometimes past midnight, and both belong to the day they sold on. The
 * tablet's own label ("Sat, Sep 19 2026") is the authority; a build that sends a
 * plain business_date is preferred over it; today in New York is the last resort.
 */
function businessDateOf(isoCandidate: unknown, label: string): string {
  const iso = String(isoCandidate ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const m = label.match(/([A-Za-z]{3,})\s+(\d{1,2})\s+(\d{4})/);
  if (m) {
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (month >= 0) {
      return `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    }
  }
  return nyNow().date;
}

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
    commission: commissionOf(body.commission),
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

  const commissionCents = report.commission == null ? null : Math.round(report.commission * 100);
  const appBuild = body.app_build ? String(body.app_build) : null;
  const deviceId = body.device_id ? String(body.device_id) : null;
  const employeeId = uuidOrNull(body.employee_id);

  // The durable record, written before anything is sent. The upsert key is
  // (kiosk, business day), so a reprint or a re-send corrects tonight's row
  // instead of adding a second one.
  const { data: closingId, error: closingError } = await sb
    .rpc("record_kiosk_closing", {
      p_kiosk_id: resolved.kiosk.id,
      p_kiosk_slug: slug,
      p_business_id: resolved.kiosk.business_id,
      p_business_date: businessDateOf(body.business_date, report.dateLabel),
      p_date_label: report.dateLabel,
      p_sales_count: report.totalCount,
      p_card_count: report.cardCount,
      p_cash_count: report.cashCount,
      p_total_cents: Math.round(report.totalSales * 100),
      p_card_cents: Math.round(report.creditSales * 100),
      p_cash_cents: Math.round(report.cashSales * 100),
      p_commission_cents: commissionCents,
      p_closed_by_name: report.representative,
      p_employee_id: employeeId,
      p_products: report.products,
      p_app_build: appBuild,
      p_device_id: deviceId,
      p_emailed: false,
      p_emailed_to: null,
      p_printed_at: report.printedAt,
    })
    .returns<string>();
  if (closingError) {
    // Losing the row must not cost the desk its email, so this is logged and the
    // close carries on. Sentry sees it through the console, the event log below
    // still holds the figures.
    console.error("[closing-report] record failed:", closingError.message);
  }

  // The event log stays: it is the tablet's activity feed, and it keeps a line per
  // attempt where kiosk_closings deliberately keeps one row per night.
  await sb.from("kiosk_events").insert({
    kiosk_id: resolved.kiosk.id,
    kiosk_slug: slug,
    business_id: resolved.kiosk.business_id,
    event: "closing_report",
    level: "info",
    app_build: appBuild,
    device_id: deviceId,
    employee_id: employeeId,
    employee_name: report.representative,
    payload: {
      total_cents: Math.round(report.totalSales * 100),
      card_cents: Math.round(report.creditSales * 100),
      cash_cents: Math.round(report.cashSales * 100),
      commission_cents: commissionCents,
      sales: report.totalCount,
      date: report.dateLabel,
    },
  });

  /** Mark tonight's row as emailed once Resend has accepted it. */
  const markEmailed = async (to: string) => {
    if (!closingId) return;
    await sb
      .from("kiosk_closings")
      .update({ emailed: true, emailed_to: to })
      .eq("id", closingId);
  };

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

  await markEmailed(to);
  return json({ ok: true, emailed: true, to }, 200);
}));
