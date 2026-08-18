// Public timeslot lookup for the /gp page. Supabase-native replacement for the Vercel
// route src/app/api/gp/slots/route.ts (itself the replacement for Xano's manage_slots).
//
// Returns the active timeslots for the matched product's master tour on a given date.
// Past times are hidden when the date is today (New York), and times closed for that
// date on the availability board are excluded.
//
// Deployed with JWT on: the public page sends the publishable anon key.
// Body: { business_tour_id, date }  ->  { slots: [{ value, label, durationMinutes }] }

import { corsHeaders, db, json } from "../_shared/gp.ts";
import { nyNow, timeLabel } from "../_shared/ny-time.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ slots: [], error: "POST only" }, 405);

  let body: { business_tour_id?: string; date?: string };
  try {
    body = await req.json();
  } catch {
    return json({ slots: [], error: "bad_request" }, 400);
  }

  const businessTourId = String(body.business_tour_id ?? "").trim();
  const date = String(body.date ?? "").trim();
  if (!businessTourId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json({ slots: [], error: "bad_request" }, 400);
  }

  const { data: bt } = await db
    .from("business_tours")
    .select("tour_id, is_active, groupon_fee_cents")
    .eq("id", businessTourId)
    .maybeSingle();
  if (!bt || !bt.is_active || bt.groupon_fee_cents === null) {
    return json({ slots: [] }, 200);
  }

  const [{ data: slots, error }, { data: closures }] = await Promise.all([
    db
      .from("tour_timeslots")
      .select("start_time, duration_minutes")
      .eq("tour_id", bt.tour_id)
      .eq("is_active", true)
      .order("sort_order", { ascending: true }),
    db
      .from("tour_slot_closures")
      .select("start_time")
      .eq("tour_id", bt.tour_id)
      .eq("closed_on", date),
  ]);
  if (error) return json({ slots: [], error: error.message }, 500);

  const closed = new Set(
    (closures ?? []).map((c: { start_time: string }) => c.start_time.slice(0, 5)),
  );

  const now = nyNow();
  const isToday = date === now.date;

  const out = (slots ?? [])
    .map((s: { start_time: string; duration_minutes: number }) => {
      const hhmm = s.start_time.slice(0, 5); // "10:30:00" -> "10:30"
      const [h, m] = hhmm.split(":").map(Number);
      return {
        value: hhmm,
        label: timeLabel(s.start_time),
        durationMinutes: s.duration_minutes,
        minutes: h * 60 + m,
      };
    })
    .filter((s) => !closed.has(s.value))
    .filter((s) => !isToday || s.minutes > now.minutes)
    .map(({ value, label, durationMinutes }) => ({ value, label, durationMinutes }));

  return json({ slots: out });
});
