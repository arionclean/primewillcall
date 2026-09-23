/**
 * Phone normalization for edge functions.
 *
 * Mirrors `normalizeUsPhone` in `src/lib/sms/format.ts`. Kept as its own module
 * because edge functions run on Deno and cannot import from `src/`.
 *
 * Why it matters: `customers.phone` stores digits only ("7865551234"), while
 * every messaging table (`sms_messages.to_phone`, `sms_opt_outs.phone_number`,
 * `scheduled_messages.to_phone`) stores E.164 ("+17865551234"), because those
 * rows come from Twilio. Comparing the two formats silently fails, which would
 * mean texting someone who replied STOP. Normalize before you queue anything.
 *
 * The ~90k rows synced from Xano do NOT all follow the digits-only rule: about
 * 60k arrived already in E.164 ("+34607960585"), and about a fifth of the book
 * is not US at all. `classifyPhone` is what reads that mixed shelf.
 */

/** A phone we are willing to send to, plus which side of the border it is on. */
export type ClassifiedPhone = {
  /** E.164, ready for Twilio. */
  e164: string;
  /** True for the +1 country code. See the NANP note on `classifyPhone`. */
  isUs: boolean;
};

/**
 * Normalize any phone to E.164 and say whether it is US.
 *
 * The rule is deliberately strict in one direction: a number is only treated as
 * international when its country code is EXPLICIT, either a leading "+" or the
 * "00" international access prefix. Bare digits that are not US-shaped are
 * refused rather than guessed, because prefixing "+" to a national number that
 * omitted its country code ("650451159") invents a different number, and a
 * guessed number is someone else's phone.
 *
 * "US" here means the +1 country code, which is the only test a phone number
 * can answer on its own. +1 is the whole NANP, so Canada and the Caribbean
 * count as US for this purpose. That is the right call for messaging anyway:
 * +1 is the range Twilio treats as domestic.
 *
 * Returns null for anything we should not send to at all (blank, junk, a
 * national number with no country code, or a length outside E.164's 7 to 15).
 */
export function classifyPhone(input: string | null | undefined): ClassifiedPhone | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Punctuation varies wildly in the synced rows ("(+44)1803225485",
  // "+34 607 96 05 85"), so reduce to "+"-and-digits once and read from there.
  const cleaned = trimmed.replace(/[^\d+]/g, "");
  // A country code is explicit when the number says so: a leading "+", or the
  // "00" international access prefix.
  const plus = cleaned.startsWith("+");
  const zeros = !plus && /^00\d/.test(cleaned);
  const marked = plus || zeros;
  const digits = cleaned.replace(/\D/g, "");
  const body = zeros ? digits.slice(2) : digits;
  // E.164 tops out at 15 digits, and nothing shorter than 7 reaches a person.
  // This is where "N/A", "6" and "1852468624995504" drop out.
  if (body.length < 7 || body.length > 15) return null;

  // Country code 1 is the entire NANP, and no other country code starts with a
  // 1, so a number that NAMES that code is US: "+13055551234",
  // "001 305 555 1234". A NANP number is always exactly 11 digits with its
  // country code, so a "+1" of any other length ("+17743338") is a truncated US
  // number, not an overseas one. It is unreachable either way, so it is refused
  // here rather than routed to the non-US trigger and failed at Twilio.
  if (marked && body.startsWith("1")) {
    return body.length === 11 ? { e164: `+${body}`, isUs: true } : null;
  }
  // Unmarked digits: 11 with the country code typed, or a bare 10 opening with
  // a real NANP area code. "0211276116" is a New Zealand mobile that lost its
  // country code, and reading it as "+10211276116" would text a number that
  // does not exist, so it falls through to the refusal below.
  if (!marked && /^1\d{10}$/.test(body)) return { e164: `+${body}`, isUs: true };
  if (!marked && /^[2-9]\d{9}$/.test(body)) return { e164: `+1${body}`, isUs: true };

  // Anything else is only sendable if it named its own country code.
  if (!marked) return null;
  // No country code starts with 0, so this is not one.
  if (body.startsWith("0")) return null;
  // Not checked: a national trunk "0" left in after the country code
  // ("+4407399489850" for a UK "+447399489850"). Finding it means knowing where
  // that country's code ends, which is a country-code table this module does
  // not carry. Twilio rejects the number and the queue row is marked failed.
  return { e164: `+${body}`, isUs: false };
}

/**
 * Normalize a US phone to E.164 (+1XXXXXXXXXX).
 * Returns null for anything that is not a valid US number, which callers treat
 * as "do not send". Use `classifyPhone` when international is in scope.
 */
export function toE164(input: string | null | undefined): string | null {
  const classified = classifyPhone(input);
  return classified?.isUs ? classified.e164 : null;
}

/**
 * A phone as `customers.phone` stores it: digits only, except that a number
 * naming a foreign country code keeps its "+".
 *
 * For a US number nothing changes: "+1 305 555 1234", "US+1 (305) 555-1234" and
 * "(305) 555-1234" all store as digits, exactly as before. A foreign number
 * needs its plus, because once the punctuation is gone the plus is the only
 * thing that says "foreign". "+47 912 34 567" (Norway) is ten digits without
 * it, `classifyPhone` reads ten bare digits as a US number, and the guest's
 * confirmation would be texted to a stranger.
 *
 * The first "+" is the one that counts, wherever it sits: the OTAs write
 * "+393408501316" and also "ES+34 612 34 56 78". A plus followed by anything
 * but a 1 is read as a foreign country code. In the first 89 Mailroom emails
 * every US number came as "+1", "US+1" or with no plus at all.
 */
export function storablePhone(input: string | null | undefined): string | null {
  const raw = input ?? "";
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  const plus = raw.indexOf("+");
  if (plus === -1) return digits;
  const international = raw.slice(plus + 1).replace(/\D/g, "");
  return international && !international.startsWith("1") ? `+${international}` : digits;
}

