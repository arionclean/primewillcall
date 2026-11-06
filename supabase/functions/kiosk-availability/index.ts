// Seats left on every departure of a New York day, for the tablet's Availability tab
// (build 29+). Every tour some business sells, not only this kiosk's products, so the
// desk can tell a guest what is still open on the other tours.
//
// Counted in the database (kiosk_availability): seats are adults plus children across
// every business, the way capacity alerts count them, cancelled bookings and unpaid
// checkouts skipped. A time closed on the website's Availability page comes back
// closed. On today, times already gone are left out.
//
// Public like the other kiosk functions (JWT off); optional KIOSK_SHARED_SECRET.
// Body:   { kiosk, date?: "YYYY-MM-DD" }  (today in New York when absent)
// Answer: { date, tours: [{ name, capacity, times: [{ time: "12:30", label: "12:30 PM",
//           booked, left, closed }] }] }   left is null when the tour has no capacity set.

import { json, kioskAuthorized, resolveKiosk, serviceClient } from "../_shared/kiosk-sale.ts";
import { nyNow, timeLabel } from "../_shared/ny-time.ts";
import { withSentry } from "../_shared/sentry.ts";

interface Row {
  tour_id: string;
  tour_name: string;
  capacity: number | null;
  start_time: string;
  booked: number;
  closed: boolean;
}

interface Slot {
  time: string;
  label: string;
  booked: number;
  left: number | null;
  closed: boolean;
}

Deno.serve(withSentry("kiosk-availability", async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!kioskAuthorized(req)) return json({ error: "unauthorized" }, 401);

  let body: { kiosk?: string; date?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const slug = String(body.kiosk ?? "").trim();
  if (!slug) return json({ error: "missing_kiosk" }, 400);
  const now = nyNow();
  const date = body.date ? String(body.date) : now.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "bad_date" }, 400);

  const sb = serviceClient();
  if (!(await resolveKiosk(sb, slug))) return json({ error: "unknown_kiosk" }, 404);

  const { data, error } = await sb.rpc("kiosk_availability", { p_day: date });
  if (error) return json({ error: error.message }, 500);

  const isToday = date === now.date;
  const tours = new Map<string, { name: string; capacity: number | null; times: Slot[] }>();
  for (const r of (data ?? []) as Row[]) {
    let tour = tours.get(r.tour_id);
    if (!tour) {
      tour = { name: r.tour_name, capacity: r.capacity, times: [] };
      tours.set(r.tour_id, tour);
    }
    const time = r.start_time.slice(0, 5);
    const [h, m] = time.split(":").map(Number);
    if (isToday && h * 60 + m <= now.minutes) continue; // already left
    tour.times.push({
      time,
      label: timeLabel(r.start_time),
      booked: r.booked,
      left: r.capacity == null ? null : Math.max(r.capacity - r.booked, 0),
      closed: r.closed,
    });
  }

  return json({ date, tours: [...tours.values()] }, 200);
}));
