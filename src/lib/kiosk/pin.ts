/**
 * Employee PIN hashing for the kiosk tablets. Byte-for-byte the same as
 * supabase/functions/_shared/kiosk-pin.ts, which verifies what this file stores.
 * hash = sha256(`${salt}:${businessId}:${pin}`), lower-case hex.
 */

export const PIN_RE = /^\d{4}$/;

export async function hashPin(salt: string, businessId: string, pin: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${salt}:${businessId}:${pin}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomSalt(): string {
  const buf = new Uint8Array(16);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
