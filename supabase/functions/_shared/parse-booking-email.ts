// Deterministic parser for Bokun OTA supplier-notification emails.
//
// Ports the field-extraction logic from the Xano email-connector endpoint
// `principal_v3_product_booking_ref` (#1922), adapted to the real Bokun layout.
// Pure and side-effect-free: given { text, subject, company } it returns the
// structured booking fields with ZERO network/AI calls. Product matching and
// the AI-classifier fallback live in the edge function, not here, so this stays
// fully unit-testable.
//
// Faithful-to-Xano note: the `adult` count is read with the same optional-digit
// regex Xano uses, so on a "PAX 3 Adult 1 Child" line it reports adult=3. We
// also surface `paxTotal` (the number after "PAX") and a `paxMismatch`
// diagnostic so a human/AI can reconcile when the totals disagree.

const BUSINESS_TZ = "America/New_York";

export type ParsedBooking = {
  company: string | null;
  bookingRef: string | null; // "Booking ref." (the OTA ref, e.g. Viator)
  bookingReference: string | null; // "Product booking ref." -> #1922 booking_reference
  extBookingRef: string | null; // "Ext. booking ref"
  productCode: string | null; // "Product <code> - ..."
  productName: string | null;
  supplier: string | null;
  soldBy: string | null;
  bookingChannel: string | null;
  customerName: string | null; // normalized "First Last"
  Fname: string | null;
  Lname: string | null;
  email: string | null;
  correctEmail: boolean;
  phone: string | null; // digits only (project phone-mask rule)
  phoneRaw: string | null;
  rate: string | null;
  adult: number;
  child: number;
  infant: number;
  paxTotal: number | null; // the "PAX N" number, when present
  paxs: number; // adult + child (per #1922)
  totalCents: number;
  currency: string;
  status: "confirmed" | "cancelled" | "pending";
  dateRaw: string | null;
  startsAtUtc: string | null; // the UTC instant as ISO-8601 (for storage / the booker)
  startsAtMs: number | null; // the SAME instant as epoch milliseconds (timezone-proof;
  // pass this as the booker's date_timestamp when a client reformats ISO strings)
  startsAtNY: string | null; // the same time, human-readable in New York
  diagnostics: Diagnostics;
};

export type Diagnostics = {
  missing: string[]; // required-ish fields that failed to extract
  paxMismatch: boolean; // adult + child + infant !== paxTotal
  emailMismatch: boolean; // the email sanity double-check failed
  dateUnparsed: boolean; // a date string was found but could not be parsed
};

// ── small helpers ─────────────────────────────────────────────────────────────
function matchOne(text: string, rx: RegExp, group = 1): string | null {
  const m = text.match(rx);
  if (!m) return null;
  const v = m[group];
  return v == null ? null : String(v).trim();
}

function toInt(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function toIntOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : null;
}

function splitName(raw: string | null): {
  customerName: string | null;
  Fname: string | null;
  Lname: string | null;
} {
  if (!raw) return { customerName: null, Fname: null, Lname: null };
  let full = raw;
  if (raw.includes(",")) {
    const i = raw.indexOf(",");
    const last = raw.slice(0, i).trim();
    const first = raw.slice(i + 1).trim();
    full = `${first} ${last}`.trim();
  }
  const sp = full.indexOf(" ");
  const Fname = sp === -1 ? full : full.slice(0, sp);
  const Lname = sp === -1 ? null : full.slice(sp + 1).trim();
  return { customerName: full || null, Fname: Fname || null, Lname };
}

function statusFromSubject(
  subject: string,
): "confirmed" | "cancelled" | "pending" {
  const s = subject.toLowerCase();
  if (s.includes("cancelled booking") || s.includes("canceled booking")) {
    return "cancelled";
  }
  // "New booking" and "Updated booking" both map to confirmed.
  return "confirmed";
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function parseOffsetMinutes(label: string): number {
  const m = label.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** Convert a wall-clock America/New_York date+time to a UTC ISO string (DST-correct). */
function nyLocalToUtcIso(
  y: number,
  mo: number,
  d: number,
  hh: number,
  mm: number,
  timezone = BUSINESS_TZ,
): string {
  const candidate = new Date(Date.UTC(y, mo - 1, d, hh, mm, 0));
  const tzLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "shortOffset",
    hour: "2-digit",
    hour12: false,
  })
    .formatToParts(candidate)
    .find((p) => p.type === "timeZoneName")?.value;
  const offsetMinutes = parseOffsetMinutes(tzLabel ?? "GMT+0");
  return new Date(candidate.getTime() - offsetMinutes * 60_000).toISOString();
}

/** Parse the Bokun date string, e.g. "Thu 18.Jun '26 @ 09:30" -> UTC ISO. */
export function parseBokunDate(raw: string): string | null {
  const m = raw.match(
    /(\d{1,2})\.([A-Za-z]{3,})\.?\s*'?(\d{2,4})\s*@\s*(\d{1,2}):(\d{2})/,
  );
  if (!m) return null;
  const day = Number(m[1]);
  const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  if (!mon || !day) return null;
  return nyLocalToUtcIso(year, mon, day, hh, mm);
}

// ── main ──────────────────────────────────────────────────────────────────────
export function parseBookingEmail(input: {
  text: string;
  subject?: string;
  company?: string;
}): ParsedBooking {
  const text = input.text ?? "";
  const subject = input.subject ?? "";
  const missing: string[] = [];
  const req = (rx: RegExp, label: string): string | null => {
    const v = matchOne(text, rx);
    if (v == null) missing.push(label);
    return v;
  };

  const bookingRef = matchOne(text, /Booking ref\.\s+(\S+)/);
  const bookingReference = req(/Product booking ref\.\s+(\S+)/, "booking_reference");
  const extBookingRef = matchOne(text, /Ext\. booking ref\s+(\S+)/);
  const productCode = matchOne(text, /Product\s+([A-Za-z0-9]+)\s+-\s+/);
  // Two Bokun layouts: "Product <CODE> - <name> Supplier" (cruise) and
  // "Product <name> Supplier" (jet ski: no code, no dash). The code+dash is
  // optional; the negative lookahead skips the earlier "Product booking ref." line.
  const productName = req(
    /Product\s+(?!booking ref\b)(?:[A-Za-z0-9]+\s+-\s+)?([\s\S]*?)\s+Supplier\b/,
    "product",
  );
  // Supplier ends at "Sold by" (cruise) or, when that line is absent, "Booking channel".
  const supplier = req(/Supplier\s+([\s\S]*?)\s+(?:Sold by|Booking channel)\b/, "supplier");
  const soldBy = matchOne(text, /Sold by\s+([\s\S]*?)\s+Booking channel\b/);
  const bookingChannel = req(
    /Booking channel\s+([\s\S]*?)\s+Customer\b/,
    "booking_channel",
  );
  const customerRaw = req(/Customer\s+([\s\S]*?)\s+Customer email\b/, "customer");
  const email1 = matchOne(text, /Customer email\s+(\S+)/);
  const email2 = matchOne(text, /Customer email\s+(\S+)\s+Customer phone\b/);
  const correctEmail = !!email1 && !!email2 && email1 === email2;
  const phoneRaw = matchOne(text, /Customer phone\s+([\s\S]*?)\s+Date\b/);
  const dateRaw = matchOne(text, /Date\s+([\s\S]*?@\s*\d{1,2}:\d{2})/);
  const rate = matchOne(text, /Rate\s+([\s\S]*?)\s+PAX\b/);

  // "PAX" is a section header in this layout, not a total: the number after it
  // belongs to the "N Adult" line. Only treat it as a real total when it is NOT
  // immediately followed by a pax-tier word.
  const paxTotal = toIntOrNull(
    matchOne(text, /\bPAX\s+(\d+)(?!\s*(?:adults?|child|children|infants?))/i),
  );
  let adult = toInt(matchOne(text, /(\d+)?\s*Adults?\b/));
  const child = toInt(matchOne(text, /(\d+)\s*Child(?:ren|s)?\b/));
  const infant = toInt(matchOne(text, /(\d+)\s*Infants?\b/));
  // Layouts with no "N Adult" line (e.g. jet ski: "PAX 1 Price per jet ski")
  // give only the PAX total; treat it as the guest count.
  if (adult + child + infant === 0 && paxTotal && paxTotal > 0) adult = paxTotal;

  let totalCents = 0;
  let currency = "usd";
  const amountM = text.match(/amount:\s*([A-Za-z]{3})\s*([\d,.]+)/);
  if (amountM) {
    currency = amountM[1].toLowerCase();
    const f = Number(amountM[2].replace(/,/g, ""));
    if (Number.isFinite(f)) totalCents = Math.round(f * 100);
  }

  const status = statusFromSubject(subject);
  const startsAtUtc = dateRaw ? parseBokunDate(dateRaw) : null;
  const startsAtMs = startsAtUtc ? new Date(startsAtUtc).getTime() : null;
  const startsAtNY = startsAtUtc
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: BUSINESS_TZ,
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(startsAtUtc))
    : null;
  const { customerName, Fname, Lname } = splitName(customerRaw);
  const phone = phoneRaw ? phoneRaw.replace(/\D/g, "") || null : null;

  return {
    company: input.company ? input.company.trim() || null : null,
    bookingRef,
    bookingReference,
    extBookingRef,
    productCode,
    productName,
    supplier,
    soldBy,
    bookingChannel,
    customerName,
    Fname,
    Lname,
    email: email1,
    correctEmail,
    phone,
    phoneRaw,
    rate,
    adult,
    child,
    infant,
    paxTotal,
    paxs: adult + child,
    totalCents,
    currency,
    status,
    dateRaw,
    startsAtUtc,
    startsAtMs,
    startsAtNY,
    diagnostics: {
      missing,
      paxMismatch: paxTotal != null && adult + child + infant !== paxTotal,
      emailMismatch: !!email1 && !correctEmail,
      dateUnparsed: !!dateRaw && startsAtUtc == null,
    },
  };
}
