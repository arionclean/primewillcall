/**
 * Employee PIN hashing, shared by kiosk-pin-verify (Deno) and mirrored byte for byte in
 * the web app (src/lib/kiosk/pin.ts) which sets PINs from /admin/employees.
 *
 * hash = sha256(`${salt}:${businessId}:${pin}`), lower-case hex. A 4-digit PIN has
 * only ten thousand values, so the salt and the per-kiosk attempt limit in
 * kiosk-pin-verify are what make the public endpoint safe to expose.
 */

export const PIN_RE = /^\d{4}$/;

export async function hashPin(salt: string, businessId: string, pin: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${salt}:${businessId}:${pin}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomSalt(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
