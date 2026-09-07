/**
 * Employee PIN hashing for the kiosk tablets. Byte-for-byte the same as
 * supabase/functions/_shared/kiosk-pin.ts (the server check) and the tablet's own
 * local check (PrimeKiosk src/config/backend.ts, js-sha256).
 * hash = sha256(`${salt}:${pin}`), lower-case hex. No business in the hash: a person
 * works at any of Prime's businesses and the PIN is unique across all of them.
 */

export const PIN_RE = /^\d{4}$/;

export async function hashPin(salt: string, pin: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${salt}:${pin}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomSalt(): string {
  const buf = new Uint8Array(16);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
