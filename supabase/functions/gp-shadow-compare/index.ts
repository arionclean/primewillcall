// Groupon /gp shadow test: grade the Supabase matcher against a real Xano voucher.
//
// One voucher in, one gp_shadow_runs row out. Xano is NEVER written to and no
// booking is created: this only calls gp-voucher-vision, the read-only half of
// the flow.
//
// POST with header `x-webhook-secret: <XANO_WEBHOOK_SECRET>` (the same secret
// xano-booking-sync already uses) and body:
//
//   {
//     "xano_ref":   "7823640",          // request id or multimedia id, for idempotency
//     "image_url":  "https://xmhi-....xano.io/vault/.../image.jpg",
//     "xano": {                          // what live Xano decided, all optional
//       "product":     "Miami Skyline Cruises",
//       "fee":         4.99,             // dollars, as vision_v4 returns it
//       "passengers":  2,
//       "voucher":     "26131626",
//       "match_score": 0.65
//     }
//   }
//
// Re-posting the same xano_ref returns the stored row instead of re-running, so
// Xano may retry freely and a replay can be re-run without duplicating rows.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("XANO_WEBHOOK_SECRET") ?? "";
const FETCH_TIMEOUT_MS = 30_000;

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Body = {
  xano_ref?: string | number;
  image_url?: string;
  source?: "xano_push" | "replay";
  xano?: {
    product?: string | null;
    fee?: number | null;
    passengers?: number | null;
    voucher?: string | null;
    match_score?: number | null;
  };
};

/** Dollars (how Xano reports the fee) to integer cents (how we store money). */
const toCents = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) : null;

/** Codes differ in case and spacing between the two systems; compare loosely. */
const sameCode = (a: unknown, b: unknown): boolean =>
  String(a ?? "").replace(/[^a-z0-9]/gi, "").toUpperCase() ===
  String(b ?? "").replace(/[^a-z0-9]/gi, "").toUpperCase();

/**
 * Product names must compare on content, not bytes. Some Xano product names hold
 * non-breaking spaces (U+00A0) where ours hold plain ones, so "Miami 5 in 1 City
 * Tour" from each side is byte-unequal and a strict compare reported the two
 * systems as disagreeing on a product they had both matched correctly.
 */
const sameProduct = (a: string, b: string): boolean =>
  a.replace(/\s+/g, " ").trim().toLowerCase() ===
  b.replace(/\s+/g, " ").trim().toLowerCase();

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!WEBHOOK_SECRET) {
    return json({ error: "server not configured: set XANO_WEBHOOK_SECRET" }, 503);
  }
  if (req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json body" }, 400);
  }

  const xanoRef = String(body.xano_ref ?? "").trim();
  const imageUrl = String(body.image_url ?? "").trim();
  const source = body.source === "replay" ? "replay" : "xano_push";
  if (!xanoRef || !imageUrl) {
    return json({ error: "xano_ref and image_url are required" }, 400);
  }

  // Already graded. Xano retries and re-run replays must not duplicate rows.
  const { data: existing } = await sb
    .from("gp_shadow_runs")
    .select("id, verdict")
    .eq("xano_ref", xanoRef)
    .maybeSingle();
  if (existing) {
    return json({ ok: true, skipped: "already_recorded", ...existing }, 200);
  }

  const x = body.xano ?? {};
  const xanoProduct = (x.product ?? null) || null;
  const row: Record<string, unknown> = {
    source,
    xano_ref: xanoRef,
    xano_image_url: imageUrl,
    xano_product: xanoProduct,
    xano_fee_cents: toCents(x.fee),
    xano_passengers: typeof x.passengers === "number" ? x.passengers : null,
    xano_voucher_code: (x.voucher ?? null) || null,
    xano_match_score: typeof x.match_score === "number" ? x.match_score : null,
  };

  const started = performance.now();
  try {
    // Copy the voucher into our own bucket: gp-voucher-vision only accepts URLs
    // from there, which is what keeps it from being pointed at arbitrary hosts.
    const img = await fetch(imageUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!img.ok) throw new Error(`voucher image fetch failed: ${img.status}`);
    const bytes = new Uint8Array(await img.arrayBuffer());
    const path = `shadow/${xanoRef}.jpg`;
    const up = await sb.storage.from("gp-vouchers").upload(path, bytes, {
      contentType: img.headers.get("content-type") ?? "image/jpeg",
      upsert: true,
    });
    if (up.error) throw new Error(`voucher image store failed: ${up.error.message}`);

    const res = await fetch(`${SUPABASE_URL}/functions/v1/gp-voucher-vision`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SERVICE_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        image_url: `${SUPABASE_URL}/storage/v1/object/public/gp-vouchers/${path}`,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`vision failed: ${res.status}`);
    const v = await res.json();
    const matched = v.matched ?? null;

    const oursProduct: string | null = matched?.product_name ?? null;
    const oursFeeCents: number | null = matched ? matched.groupon_fee_cents : null;
    const oursPassengers: number | null = v.passengers ?? null;

    const verdict = xanoProduct && oursProduct
      ? (sameProduct(xanoProduct, oursProduct) ? "agree" : "different_product")
      : xanoProduct
        ? "xano_only"
        : oursProduct
          ? "ours_only"
          : "both_none";

    Object.assign(row, {
      voucher_image_path: path,
      ours_business_tour_id: matched?.business_tour_id ?? null,
      ours_product: oursProduct,
      ours_fee_cents: oursFeeCents,
      ours_passengers: oursPassengers,
      ours_voucher_code: v.voucher_code ?? null,
      ours_match_method: v.match_method ?? null,
      ours_reason: v.reason ?? null,
      ours_merchant_seen: typeof v.merchant_seen === "boolean" ? v.merchant_seen : null,
      ours_ms: Math.round(performance.now() - started),
      verdict,
      // Only meaningful when both systems produced a value, so that a plain
      // "Xano did not read it" does not show up as a mismatch to chase.
      fee_matches: row.xano_fee_cents !== null && oursFeeCents !== null
        ? row.xano_fee_cents === oursFeeCents
        : null,
      passengers_match: row.xano_passengers !== null && oursPassengers !== null
        ? row.xano_passengers === oursPassengers
        : null,
    });
    if (row.xano_voucher_code && v.voucher_code && !sameCode(row.xano_voucher_code, v.voucher_code)) {
      row.error = `voucher code differs: xano=${row.xano_voucher_code} ours=${v.voucher_code}`;
    }
  } catch (e) {
    Object.assign(row, {
      verdict: "error",
      error: String(e),
      ours_ms: Math.round(performance.now() - started),
    });
  }

  const { data: inserted, error: insErr } = await sb
    .from("gp_shadow_runs")
    .insert(row)
    .select("id, verdict, ours_product, ours_match_method, ours_ms")
    .single();
  if (insErr) return json({ error: `insert: ${insErr.message}` }, 500);

  return json({ ok: true, ...inserted }, 200);
});
