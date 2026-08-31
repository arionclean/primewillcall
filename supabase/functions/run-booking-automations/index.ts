// Booking automation runner (ENQUEUE ONLY - never calls Twilio).
//
// The bookings AFTER INSERT trigger (on_native_booking_created) calls this once
// per Supabase-native booking, but ONLY while messaging_settings.automations_enabled
// is true. This function matches the active messaging_rules for the booking's
// product, renders each message, and inserts rows into public.scheduled_messages
// (send_at = now + delay). The dispatch-scheduled-messages worker is the single
// thing that actually sends, and it enforces the global hourly cap. So this
// function cannot itself cause a spend spike - it only queues.
//
// Auth: x-cron-secret must equal the CRON_SECRET function secret (same value the
// dispatcher uses). SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are auto-injected.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { classifyPhone } from "../_shared/phone.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

const PLACEHOLDER_RE = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

function render(body: string, vars: Record<string, string>): string {
  return body.replace(PLACEHOLDER_RE, (m, name: string) => vars[name.toLowerCase()] ?? m);
}

function firstName(fullName: string | null): string {
  return (fullName ?? "").trim().split(/\s+/)[0] ?? "";
}

function nyDate(startsAt: string | null): string {
  if (!startsAt) return "";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "2-digit",
      day: "2-digit",
      year: "numeric",
    }).format(new Date(startsAt));
  } catch {
    return "";
  }
}

interface Rule {
  id: string;
  channel: "sms" | "whatsapp";
  body: string | null;
  whatsapp_content_sid: string | null;
  whatsapp_variables: Record<string, string> | null;
  only_first_contact: boolean;
  delay_minutes: number;
  business_tour_ids: string[] | null;
}

Deno.serve(async (req) => {
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  let bookingId = "";
  try {
    bookingId = String((await req.json())?.booking_id ?? "").trim();
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  if (!bookingId) return Response.json({ error: "missing booking_id" }, { status: 400 });

  const db = createClient(SUPABASE_URL, SERVICE_KEY);

  // Kill switch (defence in depth - the trigger checks it too).
  const { data: settings } = await db
    .from("messaging_settings")
    .select("automations_enabled, booking_link_base")
    .eq("id", true)
    .maybeSingle();
  if (!settings?.automations_enabled) {
    return Response.json({ skipped: "automations disabled" });
  }

  // Idempotency: never enqueue twice for the same booking.
  const { count: already } = await db
    .from("scheduled_messages")
    .select("id", { count: "exact", head: true })
    .eq("booking_id", bookingId);
  if ((already ?? 0) > 0) {
    return Response.json({ skipped: "already enqueued" });
  }

  const { data: booking } = await db
    .from("bookings")
    .select(
      "id, business_id, business_tour_id, customer_id, public_token, starts_at, " +
        "customer:customers(full_name, phone), product:business_tours(name)",
    )
    .eq("id", bookingId)
    .maybeSingle();
  if (!booking) return Response.json({ skipped: "booking not found" });

  const customer = booking.customer as { full_name: string | null; phone: string | null } | null;
  const product = booking.product as { name: string | null } | null;
  // customers.phone is digits only for numbers this app captured, but the rows
  // synced from Xano arrive in every shape there is; everything downstream
  // (Twilio, sms_messages, sms_opt_outs) speaks E.164, so convert once here and
  // queue the E.164 form. The same read decides WHICH trigger fires: a US
  // number takes new_booking, an overseas one takes new_booking_non_us. The two
  // are exclusive, so a guest never collects both sets of messages, and a
  // number we cannot place is not sent to at all.
  const phone = classifyPhone(customer?.phone);
  if (!phone) return Response.json({ skipped: "no usable customer phone" });
  const toPhone = phone.e164;
  const triggerEvent = phone.isUs ? "new_booking" : "new_booking_non_us";

  const base = (settings.booking_link_base ?? "https://bked.io/booking").replace(/\/+$/, "");
  const vars: Record<string, string> = {
    first_name: firstName(customer?.full_name ?? null),
    product_name: product?.name ?? "",
    booking_link: booking.public_token ? `${base}/${booking.public_token}` : "",
    booking_date: nyDate(booking.starts_at),
  };

  // Active rules for this trigger. An automation names a SET of products
  // (business_tour_ids), and an empty set means "any product". That "empty or
  // contains" test does not express cleanly as a PostgREST filter on an array
  // column, so the match happens here instead: the rule set is a handful of
  // rows, so filtering in memory costs nothing.
  const { data: ruleData, error: ruleErr } = await db
    .from("messaging_rules")
    .select(
      "id, channel, body, whatsapp_content_sid, whatsapp_variables, only_first_contact, " +
        "delay_minutes, business_tour_ids",
    )
    .eq("trigger_event", triggerEvent)
    .eq("is_active", true);
  if (ruleErr) return Response.json({ error: ruleErr.message }, { status: 500 });
  const productId = booking.business_tour_id as string | null;
  const rules = ((ruleData ?? []) as Rule[]).filter((rule) => {
    const ids = rule.business_tour_ids ?? [];
    return ids.length === 0 || (productId !== null && ids.includes(productId));
  });
  if (rules.length === 0) return Response.json({ enqueued: 0 });

  // One lookup for all "first contact only" rules.
  let hasPrior = false;
  if (rules.some((r) => r.only_first_contact)) {
    const { count } = await db
      .from("sms_messages")
      .select("id", { count: "exact", head: true })
      .eq("to_phone", toPhone);
    hasPrior = (count ?? 0) > 0;
  }

  const nowMs = Date.now();
  const rows: Record<string, unknown>[] = [];
  for (const rule of rules) {
    if (rule.only_first_contact && hasPrior) continue;

    let body: string | null = null;
    let contentSid: string | null = null;
    let waVars: Record<string, string> | null = null;
    if (rule.channel === "sms") {
      body = render(rule.body ?? "", vars);
    } else {
      contentSid = rule.whatsapp_content_sid;
      waVars = {};
      for (const [slot, placeholder] of Object.entries(rule.whatsapp_variables ?? {})) {
        waVars[slot] = vars[placeholder] ?? "";
      }
    }

    const delay = Math.min(43200, Math.max(0, rule.delay_minutes ?? 0));
    rows.push({
      rule_id: rule.id,
      to_phone: toPhone,
      channel: rule.channel,
      body,
      whatsapp_content_sid: contentSid,
      whatsapp_variables: waVars,
      business_id: booking.business_id ?? null,
      booking_id: booking.id,
      customer_id: booking.customer_id ?? null,
      tag: rule.only_first_contact ? "optIn" : "bookingConfirmation",
      send_at: new Date(nowMs + delay * 60_000).toISOString(),
      status: "pending",
    });
  }

  if (rows.length === 0) return Response.json({ enqueued: 0 });

  const { error: insErr } = await db.from("scheduled_messages").insert(rows);
  if (insErr) return Response.json({ error: insErr.message }, { status: 500 });

  return Response.json({ enqueued: rows.length });
});
