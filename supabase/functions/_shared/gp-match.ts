/**
 * Deterministic product matcher for the /gp Groupon voucher flow.
 *
 * Given the OCR text of a voucher and the Groupon-enabled catalog
 * (`groupon_candidates()`), decides which product the voucher is for WITHOUT a
 * model. Three tiers, most precise first:
 *   1. title    - a product title appears verbatim in the OCR text
 *   2. fuzzy    - a title's words appear together in a short span of the text,
 *                 tolerating a dropped, inserted, or misread word (this is what
 *                 Xano's scoring lambda buys, and the tier we were missing)
 *   3. merchant - the storefront name alone. Last resort on purpose: it says who
 *                 sold the voucher, not what it is for, so it must never outrank
 *                 a title match, or a city-tour voucher whose title we failed to
 *                 read would book (and charge) the merchant's boat product.
 *
 * Lives here, not in the edge function, so it can be unit tested against real
 * OCR text (`gp-match.test.ts`). Every wrong booking so far has come from a
 * matching rule, and the only way to keep one fixed is a test that replays the
 * voucher that broke it. `gp-voucher-vision` is the only runtime caller.
 */

export type Candidate = {
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

export type Match = {
  candidate: Candidate;
  matchedName: string;
  method: "title" | "fuzzy" | "merchant";
};

/** Lowercase, letters and digits only: how verbatim comparisons are made. */
export const norm = (s: unknown): string =>
  (s ?? "").toString().toLowerCase().replace(/[^a-z0-9]+/g, "");

export const MIN_ALIAS_NORM_LEN = 8; // skip short/generic names that would false-positive
/**
 * A title needs at least this many words to count as a verbatim match. A
 * one-word product name is a category, not a title, and it turns up inside
 * other products' titles: "Transportation" (a fee-bucket product) sits verbatim
 * in "Everglades Tour with Transportation from Miami", and at 14 letters it
 * tied "Everglades Tour" on length, so whichever row Postgres happened to
 * return first won. Everglades guests were booked onto Transportation and shown
 * its 8am-8pm departures. The fuzzy tier already had this rule.
 */
const MIN_TITLE_WORDS = 2;
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

export function tokenize(s: unknown): string[] {
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
  if (wanted.size < MIN_TITLE_WORDS || ocrTokens.length === 0) return 0;

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

/**
 * Longest verbatim hit wins: the longer the title, the more specific it is. Two
 * hits of the same length are split on word count, so the answer never depends
 * on the order the catalog rows came back in.
 */
function exactMatch(
  haystack: string,
  candidates: Candidate[],
  namesOf: (c: Candidate) => string[],
): { candidate: Candidate; matchedName: string } | null {
  let best: { candidate: Candidate; matchedName: string; len: number; words: number } | null = null;
  for (const c of candidates) {
    for (const name of namesOf(c)) {
      const n = norm(name);
      if (n.length < MIN_ALIAS_NORM_LEN) continue;
      const words = tokenize(name).length;
      if (words < MIN_TITLE_WORDS) continue;
      if (!haystack.includes(n)) continue;
      if (!best || n.length > best.len || (n.length === best.len && words > best.words)) {
        best = { candidate: c, matchedName: name, len: n.length, words };
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

export function deterministicMatch(ocrText: string, candidates: Candidate[]): Match | null {
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

/**
 * Does the voucher name one of our Groupon storefronts? The gate on the model's
 * answer: asked to choose from a catalog, it picks the closest entry even when
 * the voucher belongs to someone else.
 */
export function voucherNamesMerchant(ocrText: string, candidates: Candidate[]): boolean {
  const haystack = norm(ocrText);
  return candidates.some((c) =>
    c.merchant_names.some((n) => {
      const nn = norm(n);
      return nn.length >= MIN_ALIAS_NORM_LEN && haystack.includes(nn);
    })
  );
}
