/**
 * Phone helpers shared by server code and client components.
 *
 * This module must stay free of "use client" and of Node-only imports: server
 * components import it too, and a server component cannot call a function that
 * lives in a client module.
 */

/**
 * Normalize a US phone number to E.164 (+1XXXXXXXXXX).
 * Returns null for anything that is not a valid 10-digit US number,
 * which callers treat as "do not send" (the legacy Xano flow is US-only).
 */
export function normalizeUsPhone(input: string | null | undefined): string | null {
  if (!input) {
    return null;
  }
  const digits = input.replace(/\D/g, "");
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  return null;
}

/**
 * Display a stored or E.164 US number as (XXX) XXX-XXXX.
 *
 * Anything that is not a US number is passed through unchanged, so a foreign
 * or malformed number still shows the digits we hold rather than nothing.
 * Empty input returns `fallback` (default ""), which is how a list cell asks
 * for a placeholder such as "-".
 */
export function formatUsPhoneDisplay(
  value: string | null | undefined,
  fallback = "",
): string {
  if (!value) {
    return fallback;
  }
  const digits = value.replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (local.length !== 10) {
    return value;
  }
  return `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`;
}

/** Progressive input mask for US phones: "(305) 12", "(305) 123-4567", ... */
export function maskUsPhoneInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 10);
  if (digits.length === 0) {
    return "";
  }
  if (digits.length < 4) {
    return `(${digits}`;
  }
  if (digits.length < 7) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  }
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}
