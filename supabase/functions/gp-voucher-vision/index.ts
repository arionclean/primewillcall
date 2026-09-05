// Groupon voucher vision (the Supabase port of Xano vision_v3, API #1915).
//
// Input: { image_url } pointing at the public gp-vouchers bucket. Output: the
// matched Groupon product + passengers + voucher code. Runs the same fast chain
// as Xano (~1.5s avg in production there):
//   1. OCR: Google Cloud Vision TEXT_DETECTION (GOOGLE_API_KEY). Fallback when it
//      returns no text: Groq llama-4-scout vision (GROQ_API_KEY).
//   2. Product match: DETERMINISTIC first, over the product names + the
//      tour_name_aliases of the Groupon-enabled products (groupon_candidates()
//      RPC). Three tiers: verbatim title, then a windowed word match that
//      survives a dropped or misread word (Xano's fuzzy scoring, rebuilt), then
//      the merchant name as a last resort. Zero AI in the common case. The
//      matcher lives in _shared/gp-match.ts so real OCR text can be replayed
//      through it in a unit test (gp-match.test.ts).
//   3. Extraction: Groq openai/gpt-oss-120b reads the OCR text for passengers and
//      the redemption code (the "1 of 1" trap is handled in the prompt, same as
//      Xano), and doubles as the match fallback when (2) found nothing. OpenAI
//      gpt-5.4-mini is the fallback provider if Groq errors.
//   4. Merchant gate: the model's match is only accepted when the voucher names
//      one of our Groupon storefronts (businesses.name plus
//      businesses.groupon_merchant_names). Without it the model happily maps a
//      competitor's voucher onto the nearest catalog entry.
//
// The fee always comes from the matched groupon_candidates row, never the model.
// Secrets (GOOGLE_API_KEY, GROQ_API_KEY, OPENAI_API_KEY) are Supabase function
// secrets. Auth: deployed with verify_jwt ON, so the gateway requires a valid
// project JWT (the Next /api/gp/validate route calls with the service role key).
// The function itself only ever reads from the public gp-vouchers bucket.

import { createClient } from "jsr:@supabase/supabase-js@2";

import {
  type Candidate,
  deterministicMatch,
  voucherNamesMerchant,
} from "../_shared/gp-match.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_KEY = Deno.env.get("GOOGLE_API_KEY") ?? "";
const GROQ_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const GROQ_TEXT_MODEL = "openai/gpt-oss-120b";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = "gpt-5.4-mini-2026-03-17";
const FETCH_TIMEOUT_MS = 15_000;

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ── OCR ───────────────────────────────────────────────────────────────────────
async function ocrGoogle(b64: string): Promise<string | null> {
  if (!GOOGLE_KEY) return null;
  try {
    const res = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_KEY}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requests: [
            { image: { content: b64 }, features: [{ type: "TEXT_DETECTION" }] },
          ],
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    const j = await res.json();
    const text = j?.responses?.[0]?.fullTextAnnotation?.text;
    return typeof text === "string" && text.trim() ? text : null;
  } catch {
    return null;
  }
}

async function ocrGroqVision(dataUrl: string): Promise<string | null> {
  if (!GROQ_KEY) return null;
  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${GROQ_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_VISION_MODEL,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Extract all readable text from this image. Return plain text only.",
              },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const text = j?.choices?.[0]?.message?.content;
    return typeof text === "string" && text.trim() ? text : null;
  } catch {
    return null;
  }
}

// ── Extraction (+ AI match fallback) ──────────────────────────────────────────
type Extraction = {
  passengers: number;
  voucher: string | null;
  valid: boolean;
  matched_business_tour_id: string | null;
};

function parseModelJson(content: string): Record<string, unknown> | null {
  const stripped = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function extract(
  ocrText: string,
  catalog: { business_tour_id: string; company: string; product: string; also_known_as: string[] }[],
): Promise<Extraction | null> {
  const prompt =
    "You are given the OCR text of a Groupon voucher for a tour or experience. " +
    'Respond with STRICT JSON only: {"passengers": <integer>, "voucher": <string or null>, "valid": <boolean>, "matched_business_tour_id": <id from the catalog or null>}. ' +
    "passengers = the number of people the voucher admits. Lines like '1 of 1' or '2 of 3' are VOUCHER counts, not passengers. A title like 'Sunset Cruise with the Mojito Bar On Board for Two' means 2 passengers. Always an integer; default to 1 if unclear. " +
    "voucher = the Groupon redemption or security code if present, else null. " +
    "valid = true only if this looks like a real redeemable voucher with its key information present. " +
    "matched_business_tour_id = the catalog item this voucher is for, matching the merchant/company and product title against company, product, and also_known_as. Use null if none fits.\n\n" +
    `Catalog: ${JSON.stringify(catalog)}\n\nGroupon voucher information: ${ocrText}`;

  const providers: { url: string; key: string; model: string }[] = [];
  if (GROQ_KEY) providers.push({ url: GROQ_URL, key: GROQ_KEY, model: GROQ_TEXT_MODEL });
  if (OPENAI_KEY) providers.push({ url: OPENAI_URL, key: OPENAI_KEY, model: OPENAI_MODEL });

  for (const p of providers) {
    try {
      const res = await fetch(p.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${p.key}`,
        },
        body: JSON.stringify({
          model: p.model,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const j = await res.json();
      const content = j?.choices?.[0]?.message?.content;
      if (typeof content !== "string") continue;
      const parsed = parseModelJson(content);
      if (!parsed) continue;
      const pax = Number(parsed.passengers);
      return {
        passengers: Number.isFinite(pax) && pax > 0 ? Math.floor(pax) : 1,
        voucher:
          typeof parsed.voucher === "string" && parsed.voucher.trim()
            ? parsed.voucher.trim()
            : null,
        valid: parsed.valid === true,
        matched_business_tour_id:
          typeof parsed.matched_business_tour_id === "string" &&
          parsed.matched_business_tour_id.trim()
            ? parsed.matched_business_tour_id.trim()
            : null,
      };
    } catch {
      continue;
    }
  }
  return null;
}

// ── main ──────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: { image_url?: string; debug?: boolean };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json body" }, 400);
  }
  // Opt-in echo of the OCR text. Every match decision is made from that string,
  // so without it a wrong match can only be guessed at from the voucher photo.
  // Off by default because it is the whole voucher, customer name included.
  const debug = body.debug === true;
  const imageUrl = String(body.image_url ?? "").trim();
  // Only fetch from our own public voucher bucket (SSRF guard).
  const allowedPrefix = `${SUPABASE_URL}/storage/v1/object/public/gp-vouchers/`;
  if (!imageUrl.startsWith(allowedPrefix)) {
    return json({ error: "image_url must be a gp-vouchers public URL" }, 400);
  }

  // Image bytes -> base64 (Google wants inline content; Groq gets a data URL).
  let b64: string;
  let contentType: string;
  try {
    const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!imgRes.ok) return json({ error: "could not fetch image" }, 400);
    contentType = imgRes.headers.get("content-type") ?? "image/jpeg";
    const buf = new Uint8Array(await imgRes.arrayBuffer());
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < buf.length; i += chunk) {
      bin += String.fromCharCode(...buf.subarray(i, i + chunk));
    }
    b64 = btoa(bin);
  } catch {
    return json({ error: "could not fetch image" }, 400);
  }

  // Candidates (the owner-curated Groupon products + aliases).
  const { data: candData, error: candErr } = await sb.rpc("groupon_candidates");
  if (candErr) return json({ error: `candidates: ${candErr.message}` }, 500);
  const candidates = (candData ?? []) as Candidate[];
  if (candidates.length === 0) {
    return json({ ok: true, valid: false, matched: null, reason: "no products accept Groupon" }, 200);
  }

  // 1. OCR: Google first, Groq vision fallback (same order as Xano vision_v3).
  let ocrMethod: "google" | "groq" | null = "google";
  let text = await ocrGoogle(b64);
  if (!text) {
    ocrMethod = "groq";
    text = await ocrGroqVision(`data:${contentType};base64,${b64}`);
  }
  if (!text) {
    return json(
      { ok: true, valid: false, matched: null, reason: "no readable text in the image", ocr: null },
      200,
    );
  }

  // 2. Deterministic match (zero AI in the common case).
  const det = deterministicMatch(text, candidates);

  // 3. Extraction (passengers + code), doubling as the match fallback.
  const catalog = candidates.map((c) => ({
    business_tour_id: c.business_tour_id,
    company: c.business_name,
    product: c.product_name,
    also_known_as: c.aliases.slice(0, 30),
  }));
  const ex = await extract(text, catalog);

  // 4. Merchant gate, on the model's answer only. Asked to choose from a catalog,
  //    the model picks the closest entry even when the voucher belongs to someone
  //    else: a real "Skyline & Coast Cruise" from N.Y.C Skyline Tours & Cruises
  //    came back as Miami Skyline Cruises. So its answer counts only when the
  //    voucher actually names one of our storefronts.
  //
  //    The deterministic tiers are deliberately exempt. They already require one
  //    of our own product titles in the text, which is evidence in itself, and
  //    gating them would throw away real vouchers whose photo is too poor for the
  //    storefront line to be read.
  const merchantSeen = voucherNamesMerchant(text, candidates);

  const aiCandidate =
    !det && ex?.matched_business_tour_id
      ? candidates.find((c) => c.business_tour_id === ex.matched_business_tour_id) ?? null
      : null;
  const aiMatch = merchantSeen ? aiCandidate : null;
  const matched = det?.candidate ?? aiMatch;

  const reason = matched
    ? `matched ${det ? `"${det.matchedName}" (${det.method})` : "via AI"}`
    : aiCandidate
      ? "voucher does not name one of our Groupon storefronts"
      : "voucher does not match a supported product";

  return json(
    {
      ok: true,
      valid: !!matched,
      matched,
      passengers: ex?.passengers ?? 1,
      voucher_code: ex?.voucher ?? null,
      reason,
      ocr: ocrMethod,
      match_method: det?.method ?? (aiMatch ? "ai" : null),
      merchant_seen: merchantSeen,
      ...(debug ? { ocr_text: text } : {}),
    },
    200,
  );
});
