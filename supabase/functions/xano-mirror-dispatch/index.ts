// Xano mirror worker: pg_cron calls this every minute (docs/xano-mirror.md).
//
// It drains xano_mirror_queue, the outbox the enqueue_xano_mirror trigger fills for
// every booking change made in this app, and copies each change into Xano:
//
//   create -> POST booking/v12 with the full record (add-or-edit by internal id, so a
//             retry after a half-success is idempotent). The internal id is stamped on
//             the booking BEFORE the call, so Xano's echo is matched to this row.
//   update -> PATCH booking/{id} with only the fields that changed (the partial update
//             the iPad uses for check-ins). The Xano row id is read off the booking or
//             looked up once and stored.
//
// It always sends the booking's CURRENT state, so a burst of edits collapses into one
// send and ordering cannot matter. Xano being down is a retry with backoff; a booking
// Xano cannot hold (a tour with no Xano product, a row Xano deleted) is a failure the
// dashboard shows the owner, since retrying will not fix it.
//
// Writes to bookings carry `x-sync-origin: mirror`, so the trigger ignores them.
//
// Auth: x-cron-secret must equal CRON_SECRET (same as the messaging dispatcher).

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { withSentry } from "../_shared/sentry.ts";
import {
  xanoApiToken,
  xanoCreateBooking,
  xanoGetBookingByConfirmationId,
  xanoGetBookingByInternalId,
  xanoPatchBooking,
  xanoRowId,
} from "../_shared/xano-api.ts";
import {
  buildCreatePayload,
  buildUpdatePayload,
  knownXanoId,
  MAX_ATTEMPTS,
  type MirrorBooking,
  mirrorRef,
  probableInternalId,
  retryDelaySeconds,
  unmirrorableReason,
} from "../_shared/xano-mirror.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const BATCH = 25;

const BOOKING_SELECT =
  "id, status, starts_at, pax_adult, pax_child, pax_infant, notes, checked_in_at, " +
  "legacy_id, legacy_reference, source_channel, public_token, due_cents, " +
  "xano_internal_id, xano_booking_id, " +
  "customer:customers(full_name), " +
  "business_tour:business_tours(name, legacy_product_id, tour:tours(legacy_product_id), " +
  "business:businesses(name, legacy_company_id))";

interface QueueRow {
  id: number;
  booking_id: string;
  op: "create" | "update";
  fields: string[];
  attempts: number;
}

type Outcome =
  | { kind: "sent" }
  | { kind: "retry"; error: string }
  | { kind: "failed"; error: string };

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Remember where the booking lives in Xano. Best effort: the next run learns it again. */
async function stampXanoIds(
  sb: SupabaseClient,
  bookingId: string,
  ids: { xano_internal_id?: string; xano_booking_id?: number },
): Promise<void> {
  if (Object.keys(ids).length === 0) return;
  const { error } = await sb.from("bookings").update(ids).eq("id", bookingId);
  if (error) console.error(`[xano-mirror] could not stamp ids on ${bookingId}: ${error.message}`);
}

/** Ask Xano where the row is, when the booking does not say. */
async function resolveXanoId(sb: SupabaseClient, b: MirrorBooking): Promise<number | null> {
  const known = knownXanoId(b);
  if (known) return known;

  const internalId = probableInternalId(b);
  if (internalId) {
    const r = await xanoGetBookingByInternalId(internalId);
    if (!r.ok) throw new Error(r.error);
    const id = xanoRowId(r.value);
    if (id) {
      await stampXanoIds(sb, b.id, { xano_booking_id: id, xano_internal_id: internalId });
      return id;
    }
  }

  // Every Xano-synced booking carries Xano's confirmation id as its public token.
  const r = await xanoGetBookingByConfirmationId(b.public_token);
  if (!r.ok) throw new Error(r.error);
  const id = xanoRowId(r.value);
  if (!id) return null;
  const foundInternal = (r.value as Record<string, unknown> | null)?.internal_id;
  await stampXanoIds(sb, b.id, {
    xano_booking_id: id,
    ...(typeof foundInternal === "string" && foundInternal ? { xano_internal_id: foundInternal } : {}),
  });
  return id;
}

async function processRow(sb: SupabaseClient, row: QueueRow): Promise<Outcome> {
  const { data: b, error } = await sb
    .from("bookings")
    .select(BOOKING_SELECT)
    .eq("id", row.booking_id)
    .maybeSingle<MirrorBooking>();
  if (error) return { kind: "retry", error: `read booking: ${error.message}` };
  if (!b) return { kind: "failed", error: "The booking no longer exists here." };

  const blocked = unmirrorableReason(b);
  if (blocked) return { kind: "failed", error: blocked };

  if (row.op === "create" && !b.xano_booking_id) {
    // A retry keeps the internal id it already stamped: booking/v12 adds or edits by
    // it, so Xano ends up with exactly one row however many times this runs.
    const ref = b.xano_internal_id ?? mirrorRef();
    if (!b.xano_internal_id) {
      const { error: stampErr } = await sb
        .from("bookings")
        .update({ xano_internal_id: ref })
        .eq("id", b.id)
        .is("xano_internal_id", null);
      if (stampErr) return { kind: "retry", error: `stamp internal id: ${stampErr.message}` };
    }
    const r = await xanoCreateBooking(buildCreatePayload(b, ref));
    if (!r.ok) return { kind: "retry", error: r.error };
    const id = xanoRowId(r.value);
    if (id) await stampXanoIds(sb, b.id, { xano_booking_id: id });
    return { kind: "sent" };
  }

  // An update, or a create whose row Xano already has (a retry after a success we
  // never recorded): send the changed fields, or everything when we do not know.
  const fields = row.op === "create"
    ? ["starts_at", "business_tour_id", "status", "pax", "checked_in_at", "notes", "due"]
    : row.fields;
  const updates = buildUpdatePayload(b, fields);
  if (Object.keys(updates).length === 0) return { kind: "sent" };

  let xanoId: number | null;
  try {
    xanoId = await resolveXanoId(sb, b);
  } catch (e) {
    return { kind: "retry", error: e instanceof Error ? e.message : String(e) };
  }
  if (!xanoId) return { kind: "failed", error: "Xano has no row for this booking." };

  const r = await xanoPatchBooking(xanoId, updates);
  if (!r.ok) {
    if (r.status === 404) return { kind: "failed", error: "Xano no longer has this booking." };
    return { kind: "retry", error: r.error };
  }
  return { kind: "sent" };
}

async function settle(sb: SupabaseClient, row: QueueRow, outcome: Outcome): Promise<void> {
  const now = new Date();
  let patch: Record<string, unknown>;
  if (outcome.kind === "sent") {
    patch = { status: "sent", sent_at: now.toISOString(), last_error: null };
  } else if (outcome.kind === "failed" || row.attempts >= MAX_ATTEMPTS) {
    patch = { status: "failed", last_error: outcome.error };
  } else {
    const delay = retryDelaySeconds(row.attempts);
    patch = {
      status: "pending",
      next_attempt_at: new Date(now.getTime() + delay * 1000).toISOString(),
      last_error: outcome.error,
    };
  }
  const { error } = await sb
    .from("xano_mirror_queue")
    .update({ ...patch, updated_at: now.toISOString() })
    .eq("id", row.id);
  if (error) console.error(`[xano-mirror] could not settle queue row ${row.id}: ${error.message}`);
}

Deno.serve(withSentry("xano-mirror-dispatch", async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
    global: { headers: { "x-sync-origin": "mirror" } },
  });

  const { data: settings } = await sb
    .from("xano_mirror_settings")
    .select("enabled")
    .eq("id", true)
    .maybeSingle<{ enabled: boolean }>();
  if (!settings?.enabled) return json({ enabled: false, claimed: 0 }, 200);
  if (!xanoApiToken()) return json({ error: "XANO_API_TOKEN is not set" }, 503);

  const { data, error } = await sb.rpc("claim_xano_mirror_rows", { batch: BATCH });
  if (error) return json({ error: error.message }, 500);
  const rows = (data ?? []) as QueueRow[];

  const counts = { claimed: rows.length, sent: 0, retry: 0, failed: 0 };
  for (const row of rows) {
    let outcome: Outcome;
    try {
      outcome = await processRow(sb, row);
    } catch (e) {
      outcome = { kind: "retry", error: e instanceof Error ? e.message : String(e) };
    }
    await settle(sb, row, outcome);
    counts[outcome.kind]++;
    if (outcome.kind !== "sent") {
      console.error(`[xano-mirror] ${outcome.kind} booking ${row.booking_id} (${row.op}): ${outcome.error}`);
    }
  }
  return json({ enabled: true, ...counts }, 200);
}));
