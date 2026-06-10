// OTA email -> structured booking API (the Supabase port of Xano #1922).
//
// GET ?text=&subject=&company=  OR  POST { text, subject, company }
// with header `x-webhook-secret: <EMAIL_PARSE_SECRET>`.
// It EXTRACTS the booking fields (deterministic parser) and RESOLVES the product
// to a tour + operator. It does NOT create a booking.
//
// Product resolution ladder:
//   1. Deterministic: parsed name / supplier / channel -> tour_name_aliases (0 AI).
//      If the matched operator (email company) is not assigned that tour yet, the
//      tour is still returned and a 'needs_assignment' row is queued for the owner.
//   2. AI fallback (gpt-5.4-mini-2026-03-17) only when (1) finds no tour:
//        - confident pick -> attach it + queue a 'verify' row (confirming teaches
//          the matcher); not confident -> queue an 'urgent' row for a human.
// The common templated OTA email resolves at step 1 with zero AI calls.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { parseBookingEmail } from "../_shared/parse-booking-email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRET = Deno.env.get("EMAIL_PARSE_SECRET") ?? "";
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const AI_MODEL = "gpt-5.4-mini-2026-03-17";

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Constant-time string compare (avoids leaking the secret via timing). */
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let r = 0;
  for (let i = 0; i < ea.length; i++) r |= ea[i] ^ eb[i];
  return r === 0;
}

const norm = (s: unknown): string =>
  (s ?? "").toString().toLowerCase().replace(/[^a-z0-9]+/g, "");

type Tour = { id: string; name: string };

/** Tours offered by the business behind the email's Bubble company id. */
async function candidateTours(
  company: string,
): Promise<{ businessId: string | null; tours: Tour[] }> {
  const { data: biz } = await sb
    .from("businesses")
    .select("id")
    .eq("legacy_company_id", company)
    .maybeSingle();
  const businessId = (biz?.id as string | undefined) ?? null;
  if (!businessId) {
    const { data } = await sb.from("tours").select("id, name").eq("is_active", true);
    return { businessId: null, tours: (data ?? []) as Tour[] };
  }
  const { data } = await sb
    .from("business_tours")
    .select("tour:tours(id, name)")
    .eq("business_id", businessId);
  const tours = ((data ?? []) as { tour: Tour | null }[])
    .map((r) => r.tour)
    .filter((t): t is Tour => !!t);
  return { businessId, tours };
}

type AiResult = { tour: Tour | null; confidence: "high" | "low" };

/** Single cheap classify call. Returns a tour from the candidate list or null. */
async function aiClassify(
  productText: string,
  tours: Tour[],
): Promise<AiResult | null> {
  if (!OPENAI_KEY || tours.length === 0) return null;
  const names = tours.map((t) => t.name);
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You match an OTA booking's product name to one internal tour. Respond strictly as JSON {\"tour\": <exact name from the list or null>, \"confidence\": \"high\"|\"low\"}. Use \"high\" only when you are confident; never invent a name outside the list.",
        },
        {
          role: "user",
          content: `Product: ${JSON.stringify(productText)}\nTour list: ${JSON.stringify(names)}`,
        },
      ],
      response_format: { type: "json_object" },
    }),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  let content = "";
  try {
    const j = await res.json();
    content = j.choices?.[0]?.message?.content ?? "";
  } catch {
    return null;
  }
  let parsed: { tour?: string | null; confidence?: string };
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const confidence = parsed.confidence === "high" ? "high" : "low";
  if (!parsed.tour) return { tour: null, confidence };
  const match =
    tours.find((t) => t.name === parsed.tour) ??
    tours.find((t) => norm(t.name) === norm(parsed.tour)) ??
    null;
  return { tour: match, confidence };
}

Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ error: "use GET or POST" }, 405);
  }
  if (!SECRET) {
    return json({ error: "server not configured: set EMAIL_PARSE_SECRET" }, 503);
  }
  if (!safeEqual(req.headers.get("x-webhook-secret") ?? "", SECRET)) {
    return json({ error: "unauthorized" }, 401);
  }

  // GET reads query params (?text=&subject=&company=); POST reads a JSON body.
  // Prefer POST for real traffic: the email text is large and holds PII, which
  // does not belong in a URL (length caps can truncate it, and URLs are logged).
  let text: string | undefined;
  let subject = "";
  let company = "";
  if (req.method === "GET") {
    const params = new URL(req.url).searchParams;
    text = params.get("text") ?? undefined;
    subject = params.get("subject") ?? "";
    company = params.get("company") ?? "";
  } else {
    let body: { text?: string; subject?: string; company?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid json body" }, 400);
    }
    text = body?.text;
    subject = body.subject ?? "";
    company = body.company ?? "";
  }
  if (!text || typeof text !== "string") {
    return json({ error: "missing 'text'" }, 400);
  }

  const booking = parseBookingEmail({ text, subject, company });

  // 1) deterministic
  let productMatch:
    | {
        tour_id: string;
        tour_name: string;
        business_id: string | null;
        business_tour_id: string | null;
        method: string;
        confidence: string;
      }
    | null = null;
  let queued: { id: string | null; status: string } | null = null;

  try {
    const { data } = await sb.rpc("match_ota_tour", {
      p_product: booking.productName ?? "",
      p_supplier: booking.supplier ?? "",
      p_channel: booking.bookingChannel ?? booking.soldBy ?? "",
      p_company: company,
    });
    const row = Array.isArray(data) ? data[0] : null;
    if (row) {
      productMatch = {
        tour_id: row.tour_id,
        tour_name: row.tour_name,
        business_id: row.business_id,
        business_tour_id: row.business_tour_id,
        method: row.method,
        confidence: "exact",
      };
    }
  } catch {
    // fall through to AI
  }

  // 2) matched a tour, but this operator is not assigned it -> queue for owner
  if (productMatch && !productMatch.business_tour_id) {
    let existingId: string | null = null;
    if (productMatch.business_id) {
      const { data } = await sb
        .from("email_match_queue")
        .select("id")
        .eq("reason", "needs_assignment")
        .eq("status", "urgent")
        .eq("business_id", productMatch.business_id)
        .eq("suggested_tour_id", productMatch.tour_id)
        .maybeSingle();
      existingId = (data?.id as string | undefined) ?? null;
    }
    if (existingId) {
      queued = { id: existingId, status: "urgent" };
    } else {
      const { data: q } = await sb
        .from("email_match_queue")
        .insert({
          status: "urgent",
          reason: "needs_assignment",
          original_product_name: booking.productName,
          supplier: booking.supplier,
          booking_channel: booking.bookingChannel,
          legacy_company_id: company,
          business_id: productMatch.business_id,
          suggested_tour_id: productMatch.tour_id,
          parsed: booking,
        })
        .select("id")
        .single();
      queued = { id: (q?.id as string | undefined) ?? null, status: "urgent" };
    }
  }

  // 3) no deterministic tour at all -> AI fallback + queue
  if (!productMatch) {
    const { businessId, tours } = await candidateTours(company);
    const productText = booking.productName ?? booking.rate ?? "";
    const ai = await aiClassify(productText, tours).catch(() => null);

    if (ai?.tour && ai.confidence === "high") {
      const { data: bt } = await sb
        .from("business_tours")
        .select("id")
        .eq("tour_id", ai.tour.id)
        .eq("business_id", businessId ?? "00000000-0000-0000-0000-000000000000")
        .maybeSingle();
      productMatch = {
        tour_id: ai.tour.id,
        tour_name: ai.tour.name,
        business_id: businessId,
        business_tour_id: (bt?.id as string | undefined) ?? null,
        method: "ai",
        confidence: "ai_high",
      };
      const { data: q } = await sb
        .from("email_match_queue")
        .insert({
          status: "verify",
          reason: "ai_classified",
          original_product_name: booking.productName,
          supplier: booking.supplier,
          booking_channel: booking.bookingChannel,
          legacy_company_id: company,
          business_id: businessId,
          suggested_tour_id: ai.tour.id,
          ai_confidence: ai.confidence,
          parsed: booking,
        })
        .select("id")
        .single();
      queued = { id: (q?.id as string | undefined) ?? null, status: "verify" };
    } else {
      const { data: q } = await sb
        .from("email_match_queue")
        .insert({
          status: "urgent",
          reason: "no_match",
          original_product_name: booking.productName,
          supplier: booking.supplier,
          booking_channel: booking.bookingChannel,
          legacy_company_id: company,
          business_id: businessId,
          suggested_tour_id: ai?.tour?.id ?? null,
          ai_confidence: ai?.confidence ?? null,
          parsed: booking,
        })
        .select("id")
        .single();
      queued = { id: (q?.id as string | undefined) ?? null, status: "urgent" };
    }
  }

  return json({ ok: true, booking, product_match: productMatch, queued }, 200);
});
