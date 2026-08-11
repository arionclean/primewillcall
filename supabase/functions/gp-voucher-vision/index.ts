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
//      the merchant name as a last resort. Zero AI in the common case.
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

const norm = (s: unknown): string =>
  (s ?? "").toString().toLowerCase().replace(/[^a-z0-9]+/g, "");

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Candidate = {
  business_tour_id: string;
  business_id: string;
  business_name: string;
  /** Storefront names Groupon sells this business under, including its own. */
  merchant_names: string[];
  tour_id: string;
  tour_name: string;
  product_name: string;
  groupon_fee_cents: number;
  aliases: string[];
};

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

// ── Deterministic match ───────────────────────────────────────────────────────
// Three tiers, most precise first, before the model is asked to decide:
//   1. title   - a product title appears verbatim in the OCR text
//   2. fuzzy   - a title's words appear together in a short span of the text,
//                tolerating a dropped, inserted, or misread word (this is what
//                Xano's scoring lambda buys, and the tier we were missing)
//   3. merchant- the storefront name alone. Last resort on purpose: it says who
//                sold the voucher, not what it is for, so it must never outrank
//                a title match, or a city-tour voucher whose title we failed to
//                read would book (and charge) the merchant's boat product.

const MIN_ALIAS_NORM_LEN = 8; // skip short/generic names that would false-positive
const FUZZY_MIN_COVERAGE = 0.7; // share of a title's words the voucher must carry
const FUZZY_WINDOW_SLACK = 4; // words a voucher may insert inside a title
const FUZZY_MIN_MARGIN = 0.1; // two products this close = ambiguous, ask the model

/** Words too common to distinguish one product from another. */
const STOPWORDS = new Set([
  "the", "a", "an", "of", "with", "and", "in", "on", "for", "to", "your", "at",
  "from", "by", "or", "our", "you", "it", "is", "this", "that",
]);

/** Naive plural strip so "cruises"/"cruise" and "tours"/"tour" compare equal. */
const stem = (t: string): string => (t.length >= 4 && t.endsWith("s") ? t.slice(0, -1) : t);

/**
 * Words that identify WHICH product. If a title carries one and the voucher
 * never says it, they are different products. This is what stops a "City Tour &
 * Boat Combo" title from matching a plain city-tour voucher.
 */
const DISTINCTIVE = new Set(
  [
    "combo", "boat", "bus", "jet", "ski", "everglades", "airboat", "key", "west",
    "night", "sunset", "star", "island", "party", "empanada", "mojito", "sea",
    "transportation", "bayside", "cruise", "tour", "city", "skyline", "land",
    "private", "helicopter",
  ].map(stem),
);

function tokenize(s: unknown): string[] {
  return (s ?? "")
    .toString()
    .toLowerCase()
    .replace(/\b\d+\s*of\s*\d+\b/g, " ") // "1 of 1" counts vouchers, not passengers
    .replace(/\bfor\s+\d+\b/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !STOPWORDS.has(t))
    .map(stem);
}

/**
 * Words that split one product from another. If the voucher says one right next
 * to the title and the title does not, they are different products: "Miami City
 * Tour and Boat Combo" is the combo product, not the city tour.
 */
const SPLITTERS = new Set(
  [
    "combo", "boat", "bus", "jet", "ski", "everglades", "airboat", "party",
    "transportation", "helicopter",
  ].map(stem),
);

/**
 * The titles that describe the product itself. Names that ARE the merchant name
 * are dropped here and only ever match at tier 3: "Miami Skyline Cruises" is the
 * storefront on every voucher that business sells, including its city-tour ones,
 * so letting it compete as a title would book city-tour guests onto the boat.
 */
const titlesOf = (c: Candidate): string[] => {
  const merchant = norm(c.business_name);
  return [c.product_name, c.tour_name, ...c.aliases].filter((n) => norm(n) !== merchant);
};

/**
 * Share of `title`'s words found together inside one short span of the voucher.
 * Windowing is what keeps this honest: without it a title could be assembled
 * from words scattered across the whole voucher, including the fine print.
 */
function fuzzyScore(ocrTokens: string[], ocrSet: Set<string>, title: string): number {
  const wanted = new Set(tokenize(title));
  if (wanted.size < 2 || ocrTokens.length === 0) return 0;

  for (const t of wanted) {
    if (DISTINCTIVE.has(t) && !ocrSet.has(t)) return 0;
  }

  const size = Math.min(ocrTokens.length, wanted.size + FUZZY_WINDOW_SLACK);
  const counts = new Map<string, number>();
  const bump = (t: string, delta: number) => {
    const n = (counts.get(t) ?? 0) + delta;
    if (n <= 0) counts.delete(t);
    else counts.set(t, n);
  };

  let best = 0;
  for (let i = 0; i < ocrTokens.length; i++) {
    bump(ocrTokens[i], 1);
    if (i >= size) bump(ocrTokens[i - size], -1);
    if (i + 1 < size) continue;

    // A splitter sitting inside the window that the title does not claim means
    // the voucher is for a neighbouring product. Skip this window, not the title:
    // the same title may still fit cleanly somewhere else in the voucher.
    let contaminated = false;
    for (const t of counts.keys()) {
      if (SPLITTERS.has(t) && !wanted.has(t)) {
        contaminated = true;
        break;
      }
    }
    if (contaminated) continue;

    let hit = 0;
    for (const t of wanted) if (counts.has(t)) hit++;
    best = Math.max(best, hit / wanted.size);
    if (best === 1) break;
  }
  return best;
}

type Match = {
  candidate: Candidate;
  matchedName: string;
  method: "title" | "fuzzy" | "merchant";
};

/** Longest verbatim hit wins: the longer the title, the more specific it is. */
function exactMatch(
  haystack: string,
  candidates: Candidate[],
  namesOf: (c: Candidate) => string[],
): { candidate: Candidate; matchedName: string } | null {
  let best: { candidate: Candidate; matchedName: string; len: number } | null = null;
  for (const c of candidates) {
    for (const name of namesOf(c)) {
      const n = norm(name);
      if (n.length < MIN_ALIAS_NORM_LEN) continue;
      if (!haystack.includes(n)) continue;
      if (!best || n.length > best.len) {
        best = { candidate: c, matchedName: name, len: n.length };
      }
    }
  }
  return best ? { candidate: best.candidate, matchedName: best.matchedName } : null;
}

function fuzzyMatch(
  ocrText: string,
  candidates: Candidate[],
): { candidate: Candidate; matchedName: string } | null {
  const ocrTokens = tokenize(ocrText);
  const ocrSet = new Set(ocrTokens);

  const ranked = candidates
    .map((c) => {
      let score = 0;
      let matchedName = "";
      for (const title of titlesOf(c)) {
        const s = fuzzyScore(ocrTokens, ocrSet, title);
        if (s > score) {
          score = s;
          matchedName = title;
        }
      }
      return { candidate: c, matchedName, score };
    })
    .filter((r) => r.score >= FUZZY_MIN_COVERAGE)
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) return null;
  // Two products fit about equally well. Guessing here books the wrong product
  // and charges the wrong business, so hand the tie to the model instead.
  if (ranked.length > 1 && ranked[0].score - ranked[1].score < FUZZY_MIN_MARGIN) return null;
  return { candidate: ranked[0].candidate, matchedName: ranked[0].matchedName };
}

function deterministicMatch(ocrText: string, candidates: Candidate[]): Match | null {
  const haystack = norm(ocrText);
  if (!haystack) return null;

  const title = exactMatch(haystack, candidates, titlesOf);
  if (title) return { ...title, method: "title" };

  const fuzzy = fuzzyMatch(ocrText, candidates);
  if (fuzzy) return { ...fuzzy, method: "fuzzy" };

  // The storefront names a business, not a product, so it is only decisive when
  // that business sells exactly one Groupon-enabled product. Otherwise picking
  // one would be a coin flip between different products AND different fees.
  const merchant = exactMatch(haystack, candidates, (c) => c.merchant_names);
  if (merchant) {
    const sold = candidates.filter((c) => c.business_id === merchant.candidate.business_id);
    if (sold.length === 1) return { ...merchant, method: "merchant" };
  }

  return null;
}

// ── main ──────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: { image_url?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json body" }, 400);
  }
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

  const haystack = norm(text);

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
  const merchantSeen = candidates.some((c) =>
    c.merchant_names.some((n) => {
      const nn = norm(n);
      return nn.length >= MIN_ALIAS_NORM_LEN && haystack.includes(nn);
    })
  );

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
    },
    200,
  );
});
