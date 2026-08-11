// One-off backfill: booking voucher photos (and peek=true flags) from Xano
// into Supabase.
//
// READ-ONLY against Xano: sweeps the public day-manifest endpoint
// (api:2k2IsvEZ/querry_all) one date at a time; never writes to Xano.
// Writes only bookings.groupon_voucher_urls and bookings.peek in Supabase,
// matching rows by the same legacy_id keying the xano-booking-sync webhook
// uses (ota-<booking_reference> / unique_id / xano-<row id>), with a
// public_token = bookingConfirmation_id fallback for photos.
//
// peek is backfilled one-way (only set true where Xano says true); it never
// clears a peek set in the new app.
//
// Usage: node scripts/backfill_booking_photos.mjs [startDate] [endDate]
//   defaults: 2024-01-01 .. 2027-08-01

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const XANO_DAY_URL =
  "https://xmhi-aj9d-cnsb.n7.xano.io/api:2k2IsvEZ/querry_all?date=";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const startDate = process.argv[2] ?? "2024-01-01";
const endDate = process.argv[3] ?? "2027-08-01";

function* dates(from, to) {
  const d = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (d <= end) {
    yield d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

function imageUrls(arr) {
  if (!Array.isArray(arr)) return [];
  const urls = [];
  for (const item of arr) {
    if (typeof item === "string" && item.trim()) urls.push(item.trim());
    else if (item && typeof item === "object" && typeof item.url === "string" && item.url.trim()) {
      urls.push(item.url.trim());
    }
  }
  return urls;
}

function keysFor(row) {
  const keys = [];
  const ref = typeof row.booking_reference === "string" ? row.booking_reference.trim() : "";
  if (ref && !ref.toLowerCase().startsWith("kiosk-sale")) keys.push(`ota-${ref}`);
  const uid = typeof row.unique_id === "string" ? row.unique_id.trim() : "";
  if (uid) keys.push(uid);
  if (row.id != null) keys.push(`xano-${row.id}`);
  return keys;
}

async function fetchDay(date, attempt = 1) {
  try {
    // Hard timeout: a hung socket must not wedge a worker for the whole run.
    const res = await fetch(XANO_DAY_URL + encodeURIComponent(date), {
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const groups = Array.isArray(body?.bookings) ? body.bookings : [];
    return groups.flatMap((g) => (Array.isArray(g?.bookings) ? g.bookings : []));
  } catch (err) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      return fetchDay(date, attempt + 1);
    }
    throw err;
  }
}

const photoRows = []; // { keys, token, urls }
const peekKeys = new Set();
let scanned = 0;
let failedDays = [];

const allDates = [...dates(startDate, endDate)];
console.log(`Sweeping ${allDates.length} days ${startDate}..${endDate}`);

const CONCURRENCY = 6;
let cursor = 0;
async function worker() {
  while (cursor < allDates.length) {
    const date = allDates[cursor++];
    try {
      const rows = await fetchDay(date);
      scanned += rows.length;
      for (const row of rows) {
        const urls = imageUrls(row.image_url);
        if (urls.length > 0) {
          photoRows.push({
            keys: keysFor(row),
            token:
              typeof row.bookingConfirmation_id === "string" &&
              row.bookingConfirmation_id.trim()
                ? row.bookingConfirmation_id.trim()
                : null,
            urls,
          });
        }
        if (row.peek === true) for (const k of keysFor(row)) peekKeys.add(k);
      }
    } catch (err) {
      failedDays.push(date);
      console.error(`  ${date} failed: ${err.message}`);
    }
    const done = cursor;
    if (done % 50 === 0) {
      console.log(
        `  ...${done}/${allDates.length} days, ${scanned} bookings, ${photoRows.length} with photos`,
      );
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(
  `Scanned ${scanned} bookings. With photos: ${photoRows.length}. Peek=true: ${peekKeys.size} keys. Failed days: ${failedDays.length}`,
);

// ── Photos: per booking (each has its own URL list) ─────────────────────────
let photosUpdated = 0;
let photosMissed = 0;
for (const p of photoRows) {
  let matched = false;
  for (const key of p.keys) {
    const { data, error } = await sb
      .from("bookings")
      .update({ groupon_voucher_urls: p.urls })
      .eq("legacy_id", key)
      .select("id");
    if (!error && data && data.length > 0) {
      matched = true;
      break;
    }
  }
  if (!matched && p.token) {
    const { data, error } = await sb
      .from("bookings")
      .update({ groupon_voucher_urls: p.urls })
      .eq("public_token", p.token)
      .select("id");
    if (!error && data && data.length > 0) matched = true;
  }
  if (matched) photosUpdated++;
  else {
    photosMissed++;
    if (photosMissed <= 5) console.log(`  no match for photos: ${p.keys.join(", ")}`);
  }
}

// ── Peek: bulk, true-only, in chunks ────────────────────────────────────────
let peekUpdated = 0;
const keys = [...peekKeys];
for (let i = 0; i < keys.length; i += 200) {
  const chunk = keys.slice(i, i + 200);
  const { data, error } = await sb
    .from("bookings")
    .update({ peek: true })
    .in("legacy_id", chunk)
    .eq("peek", false)
    .select("id");
  if (error) console.error(`  peek chunk failed: ${error.message}`);
  else peekUpdated += data?.length ?? 0;
}

console.log(
  `Done. Photos: ${photosUpdated} bookings updated, ${photosMissed} unmatched. Peek set true on ${peekUpdated} bookings.`,
);
if (failedDays.length > 0) {
  console.log(`Retry these days later: ${failedDays.join(", ")}`);
}
