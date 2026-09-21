/**
 * Employee PIN hashing, shared by kiosk-pin-verify (Deno) and mirrored byte for byte in
 * the web app (src/lib/kiosk/pin.ts) which sets PINs from /admin/employees.
 *
 * hash = sha256(`${salt}:${pin}`), lower-case hex. No business in the hash: employees
 * are one pool shared by every business, and the PIN is unique across the pool. The
 * tablet checks the same hash locally.
 */

export const PIN_RE = /^\d{4}$/;

export async function hashPin(salt: string, pin: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${salt}:${pin}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomSalt(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The employee a PIN belongs to, out of a list already narrowed to the active
 * ones. PINs are unique across the pool, so the first match is the person.
 *
 * Takes rows rather than a database client on purpose: this module is mirrored
 * byte for byte in the web app and stays free of dependencies.
 */
export async function matchPin<T extends { pin_hash: string; pin_salt: string }>(
  rows: T[],
  pin: string,
): Promise<T | null> {
  if (!PIN_RE.test(pin)) return null;
  for (const row of rows) {
    if ((await hashPin(row.pin_salt, pin)) === row.pin_hash) return row;
  }
  return null;
}
