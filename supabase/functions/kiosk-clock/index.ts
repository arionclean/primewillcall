// Time clock for the PrimeKiosk tablet: clock in, clock out, and the state between.
//
// One call answers all three questions a tablet has (who is this PIN, are they on
// the clock, and record the punch), because the person is standing there waiting:
//
//   op=status  ->  who the PIN belongs to and their open shift, if any
//   op=in      ->  opens a shift; multipart, with the front-camera photo
//   op=out     ->  closes the open shift
//
// The PIN is checked HERE, against the live employee list, on every op. The other
// kiosk functions accept an employee_id the tablet claims, because a wrong one only
// mis-labels a sale; a shift is a payroll record, so this one proves the person
// instead of trusting the caller.
//
// The switch is kiosks.time_clock. Off, this refuses everything, so turning the
// column on is the whole rollout and turning it off is the whole rollback.
//
// Public like the other kiosk functions (verify_jwt off); optional KIOSK_SHARED_SECRET.

import { matchPin, PIN_RE } from "../_shared/kiosk-pin.ts";
import { json, kioskAuthorized, logEvent, resolveKiosk, serviceClient } from "../_shared/kiosk-sale.ts";
import { withSentry } from "../_shared/sentry.ts";

const PHOTO_BUCKET = "time-clock-photos";
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const PHOTO_TYPES = new Set(["image/jpeg", "image/jpg", "image/png"]);

interface EmployeeRow {
  id: string;
  name: string;
  pin_hash: string;
  pin_salt: string;
}

interface ShiftRow {
  id: string;
  clock_in_at: string;
  clock_out_at: string | null;
  clock_in_kiosk_slug: string | null;
  photo_path: string | null;
}

/** The shift as the tablet shows it: when it started, and how long it has run. */
function shiftView(s: ShiftRow) {
  const end = s.clock_out_at ? new Date(s.clock_out_at) : new Date();
  const minutes = Math.max(0, Math.round((end.getTime() - new Date(s.clock_in_at).getTime()) / 60000));
  return {
    id: s.id,
    clock_in_at: s.clock_in_at,
    clock_out_at: s.clock_out_at,
    kiosk: s.clock_in_kiosk_slug,
    minutes,
  };
}

const SHIFT_COLUMNS = "id, clock_in_at, clock_out_at, clock_in_kiosk_slug, photo_path";

Deno.serve(withSentry("kiosk-clock", async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!kioskAuthorized(req)) return json({ error: "unauthorized" }, 401);

  // status and out are JSON; a clock in arrives as multipart so the photo rides
  // along with it (React Native uploads a file, it cannot hand us base64 cheaply).
  let op = "";
  let slug = "";
  let pin = "";
  let appBuild: string | null = null;
  let deviceId: string | null = null;
  let photo: File | null = null;

  const contentType = req.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const field = (k: string) => {
        const v = form.get(k);
        return typeof v === "string" ? v.trim() : "";
      };
      op = field("op");
      slug = field("kiosk");
      pin = field("pin");
      appBuild = field("app_build") || null;
      deviceId = field("device_id") || null;
      const file = form.get("photo");
      if (file instanceof File && file.size > 0) photo = file;
    } else {
      const body = await req.json();
      op = String(body?.op ?? "").trim();
      slug = String(body?.kiosk ?? "").trim();
      pin = String(body?.pin ?? "").trim();
      appBuild = body?.app_build ? String(body.app_build) : null;
      deviceId = body?.device_id ? String(body.device_id) : null;
    }
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  if (op !== "status" && op !== "in" && op !== "out") return json({ error: "bad_op" }, 400);
  if (!slug) return json({ error: "missing_kiosk" }, 400);
  if (!PIN_RE.test(pin)) return json({ error: "bad_pin" }, 401);

  const sb = serviceClient();
  const resolved = await resolveKiosk(sb, slug);
  if (!resolved) return json({ error: "unknown_kiosk" }, 404);
  const { kiosk } = resolved;

  // The switch, read with its own query: nothing new ever goes into resolveKiosk's
  // select, which feeds every other kiosk function.
  const { data: sw } = await sb
    .from("kiosks")
    .select("time_clock")
    .eq("id", kiosk.id)
    .maybeSingle<{ time_clock: boolean | null }>();
  if (!sw?.time_clock) return json({ error: "time_clock_off" }, 403);

  const meta = {
    kioskId: kiosk.id,
    kioskSlug: kiosk.slug,
    businessId: kiosk.business_id,
    appBuild,
    deviceId,
  };

  // Who typed it. Employees are one pool shared by every business and a PIN is
  // unique across it, so the digits alone name the person.
  const { data: employees } = await sb
    .from("kiosk_employees")
    .select("id, name, pin_hash, pin_salt")
    .eq("is_active", true)
    .returns<EmployeeRow[]>();
  const employee = await matchPin(employees ?? [], pin);
  if (!employee) {
    await logEvent(sb, { ...meta, event: "pin_failed", level: "warn", payload: { at: "time_clock" } });
    return json({ error: "bad_pin" }, 401);
  }

  const who = { id: employee.id, name: employee.name };
  const openShift = async (): Promise<ShiftRow | null> => {
    const { data } = await sb
      .from("time_clock_shifts")
      .select(SHIFT_COLUMNS)
      .eq("employee_id", employee.id)
      .is("clock_out_at", null)
      .maybeSingle<ShiftRow>();
    return data ?? null;
  };

  // ── status: what the keypad needs to decide which screen to show ────────────
  if (op === "status") {
    const open = await openShift();
    return json({ ok: true, employee: who, shift: open ? shiftView(open) : null }, 200);
  }

  // ── in: open a shift, with the photo the tablet just took ───────────────────
  if (op === "in") {
    const already = await openShift();
    if (already) return json({ ok: true, already_in: true, employee: who, shift: shiftView(already) }, 200);

    const shiftId = crypto.randomUUID();
    let photoPath: string | null = null;
    if (photo && photo.size <= MAX_PHOTO_BYTES && PHOTO_TYPES.has(photo.type || "image/jpeg")) {
      const path = `${employee.id}/${shiftId}.jpg`;
      const bytes = new Uint8Array(await photo.arrayBuffer());
      const up = await sb.storage.from(PHOTO_BUCKET).upload(path, bytes, {
        contentType: photo.type || "image/jpeg",
        upsert: true,
      });
      // A photo that will not upload never stops someone starting work. The shift
      // is recorded without one and the owner's screen says so.
      if (up.error) console.error("kiosk-clock: photo upload failed", up.error);
      else photoPath = path;
    }

    const { data: created, error } = await sb
      .from("time_clock_shifts")
      .insert({
        id: shiftId,
        employee_id: employee.id,
        employee_name: employee.name,
        clock_in_at: new Date().toISOString(),
        clock_in_kiosk_id: kiosk.id,
        clock_in_kiosk_slug: kiosk.slug,
        photo_path: photoPath,
      })
      .select(SHIFT_COLUMNS)
      .maybeSingle<ShiftRow>();

    if (error) {
      // 23505: the partial unique index caught a second clock in (two tablets at
      // once). Whoever lost the race gets the shift that exists, not an error.
      if (error.code === "23505") {
        if (photoPath) await sb.storage.from(PHOTO_BUCKET).remove([photoPath]);
        const open = await openShift();
        if (open) return json({ ok: true, already_in: true, employee: who, shift: shiftView(open) }, 200);
      }
      console.error("kiosk-clock: clock in failed", error);
      return json({ error: "clock_in_failed" }, 500);
    }

    await Promise.all([
      sb
        .from("kiosk_employees")
        .update({ last_seen_at: new Date().toISOString(), last_seen_kiosk: kiosk.slug })
        .eq("id", employee.id),
      logEvent(sb, {
        ...meta,
        event: "clock_in",
        employeeId: employee.id,
        employeeName: employee.name,
        payload: { photo: Boolean(photoPath) },
      }),
    ]);

    return json({ ok: true, employee: who, shift: created ? shiftView(created) : null }, 200);
  }

  // ── out: close the open shift ───────────────────────────────────────────────
  const open = await openShift();
  if (!open) return json({ ok: true, not_in: true, employee: who, shift: null }, 200);

  const { data: closed, error } = await sb
    .from("time_clock_shifts")
    .update({
      clock_out_at: new Date().toISOString(),
      clock_out_kiosk_id: kiosk.id,
      clock_out_kiosk_slug: kiosk.slug,
    })
    .eq("id", open.id)
    .is("clock_out_at", null)
    .select(SHIFT_COLUMNS)
    .maybeSingle<ShiftRow>();

  if (error) {
    console.error("kiosk-clock: clock out failed", error);
    return json({ error: "clock_out_failed" }, 500);
  }
  // Another tablet closed it in the same breath: report the shift as it stands.
  const shift = closed ?? (await openShift()) ?? open;

  await Promise.all([
    sb
      .from("kiosk_employees")
      .update({ last_seen_at: new Date().toISOString(), last_seen_kiosk: kiosk.slug })
      .eq("id", employee.id),
    logEvent(sb, {
      ...meta,
      event: "clock_out",
      employeeId: employee.id,
      employeeName: employee.name,
      payload: { minutes: shiftView(shift).minutes },
    }),
  ]);

  return json({ ok: true, employee: who, shift: shiftView(shift) }, 200);
}));
