// Server-only: node:crypto and next/headers make it so; never import from a client component.
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

/**
 * The employee behind a shared web login.
 *
 * A login marked `staff.pin_required` is one computer used by several people. Once
 * someone types their PIN, who they are lives in two cookies for the rest of the
 * session (until they tap Lock): a signed, httpOnly one the server trusts, and a
 * plain one carrying only the id, which the browser Supabase client reads to send
 * the `x-employee-id` header on every request. That header is what the database
 * trigger stamps on the activity log, so a direct edit from the bookings page is
 * attributed the same way a server action is.
 *
 * The signature stops a forged cookie from unlocking the screen as someone else.
 * The header is not signed: a PIN is attribution, not a secret guarding money
 * (the same stance as the tablet), and the trigger only accepts an id that exists
 * and is active.
 */

export const EMPLOYEE_COOKIE = "pwc_employee"; // signed, httpOnly: id.name.signature
export const EMPLOYEE_ID_COOKIE = "pwc_employee_id"; // plain: id, for the request header
export const EMPLOYEE_HEADER = "x-employee-id";

export type WebEmployee = { id: string; name: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function secret(): string {
  // Server-only by construction; never reaches the browser.
  const s = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!s) throw new Error("No secret available to sign the employee cookie.");
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function encodeEmployeeCookie(e: WebEmployee): string {
  const payload = `${e.id}.${Buffer.from(e.name, "utf8").toString("base64url")}`;
  return `${payload}.${sign(payload)}`;
}

export function decodeEmployeeCookie(raw: string | undefined): WebEmployee | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [id, name64, sig] = parts;
  if (!UUID_RE.test(id)) return null;
  const expected = sign(`${id}.${name64}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let name = "";
  try {
    name = Buffer.from(name64, "base64url").toString("utf8");
  } catch {
    return null;
  }
  return { id, name };
}

/** The unlocked employee on this request, or null when nobody has typed a PIN. */
export async function getWebEmployee(): Promise<WebEmployee | null> {
  const store = await cookies();
  return decodeEmployeeCookie(store.get(EMPLOYEE_COOKIE)?.value);
}

/** The id to send as the request header, read the cheap way (no signature check). */
export async function getWebEmployeeIdForHeader(): Promise<string | null> {
  const store = await cookies();
  const id = store.get(EMPLOYEE_ID_COOKIE)?.value ?? "";
  return UUID_RE.test(id) ? id : null;
}

const COOKIE_BASE = { path: "/", sameSite: "lax" as const, secure: process.env.NODE_ENV === "production" };

export async function setWebEmployeeCookies(e: WebEmployee): Promise<void> {
  const store = await cookies();
  // Session cookies on purpose: closing the browser ends the person's turn.
  store.set(EMPLOYEE_COOKIE, encodeEmployeeCookie(e), { ...COOKIE_BASE, httpOnly: true });
  store.set(EMPLOYEE_ID_COOKIE, e.id, { ...COOKIE_BASE, httpOnly: false });
}

export async function clearWebEmployeeCookies(): Promise<void> {
  const store = await cookies();
  store.set(EMPLOYEE_COOKIE, "", { ...COOKIE_BASE, httpOnly: true, maxAge: 0 });
  store.set(EMPLOYEE_ID_COOKIE, "", { ...COOKIE_BASE, httpOnly: false, maxAge: 0 });
}
