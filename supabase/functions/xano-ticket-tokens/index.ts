// Xano ticket tokens sweep (READ-ONLY on Xano).
//
// Stamps bookings.xano_confirmation_token, Xano's bookingConfirmation_id, on the
// upcoming bookings that lack it. That is the code in the bked.io/booking/<code>
// link Xano still texts every guest it books (the OTA email connector, the iPads),
// and /booking/[token] accepts it as a second id, so those links open here once
// pro.primewillcall.com points at this app instead of Bubble.
//
// Why a sweep and not the sync: 77% of recent bookings were created here first,
// from the OTA email, and Xano mints the code AFTER the insert trigger that calls
// xano-booking-sync, so the echo never carries it (0 of the last 579 OTA bookings
// had it). public_token cannot take it later: our own texts already carry ours.
//
// Scope, deliberately narrow:
//   * starts_at in the future, not cancelled, not an unpaid checkout: a link for a
//     tour that already happened is not worth a call;
//   * xano_internal_id present (that is how the Xano row is found);
//   * public_token not already Xano's 9-char code (the sync-created 23%);
//   * at most BATCH rows per run, CONCURRENCY GETs at a time, so the backlog drains
//     over a few hourly runs instead of one burst at Xano.
//
// Safety: Xano reuses a PW- code across people now and then, so the row it returns
// is stamped only when its booking_reference matches ours (or, when we hold no
// reference, its tour date does). A mismatch is skipped and reported, never guessed.
//
// Writes touch only the new column, which no bookings trigger reads: nothing is
// queued for Xano, no automation fires, no log row is written (the triggers were
// each read before this was built). Nothing is ever written to Xano.
//
// Auth: x-cron-secret must equal the CRON_SECRET function secret.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { withSentry } from "../_shared/sentry.ts";
import { xanoGetBookingByInternalId } from "../_shared/xano-api.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

const BATCH = 200;
const CONCURRENCY = 4;

type Candidate = {
  id: string;
  xano_internal_id: string;
  legacy_reference: string | null;
  starts_at: string;
};

const NY_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function clean(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** True when the Xano row is the same booking as ours, not a reused PW- code. */
function sameBooking(ours: Candidate, xano: Record<string, unknown>): boolean {
  const theirRef = clean(xano.booking_reference);
  if (ours.legacy_reference && theirRef) return ours.legacy_reference === theirRef;
  const theirDate = clean(xano.date);
  return theirDate !== null && theirDate === NY_DAY.format(new Date(ours.starts_at));
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

Deno.serve(withSentry("xano-ticket-tokens", async (req) => {
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const db = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: rows, error } = await db
    .from("bookings")
    .select("id, xano_internal_id, legacy_reference, starts_at, public_token")
    .is("xano_confirmation_token", null)
    .not("xano_internal_id", "is", null)
    .gt("starts_at", new Date().toISOString())
    .neq("status", "cancelled")
    .eq("awaiting_payment", false)
    .order("starts_at", { ascending: true })
    .limit(BATCH);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  // The sync-created minority already carries Xano's code as its public_token.
  const candidates = (rows ?? []).filter((r) => (r.public_token ?? "").length !== 9) as Candidate[];

  let stamped = 0;
  let missing = 0;
  let mismatched = 0;
  const failed: string[] = [];

  await mapLimit(candidates, CONCURRENCY, async (b) => {
    const res = await xanoGetBookingByInternalId(b.xano_internal_id);
    if (!res.ok) {
      failed.push(`${b.xano_internal_id}: ${res.error}`);
      return;
    }
    const xano = res.value;
    const code = xano ? clean(xano.bookingConfirmation_id) : null;
    if (!xano || !code) {
      missing++;
      return;
    }
    if (!sameBooking(b, xano)) {
      mismatched++;
      return;
    }
    const { error: upErr } = await db
      .from("bookings")
      .update({ xano_confirmation_token: code })
      .eq("id", b.id);
    if (upErr) failed.push(`${b.xano_internal_id}: ${upErr.message}`);
    else stamped++;
  });

  return Response.json({
    scanned: candidates.length,
    stamped,
    missing,
    mismatched,
    failed: failed.slice(0, 20),
    failed_count: failed.length,
  });
}));
