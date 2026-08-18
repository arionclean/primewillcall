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
 */

/**
 * Normalize a US phone to E.164 (+1XXXXXXXXXX).
 * Returns null for anything that is not a valid US number, which callers treat
 * as "do not send" (the legacy Xano flow is US-only).
 */
export function toE164(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}
