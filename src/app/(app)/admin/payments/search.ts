/**
 * Smart search for /admin/payments.
 *
 * Staff type one box. Words it recognises become real filters (tender, status,
 * a day) and everything left over stays a text match on name / email / last4 /
 * sale ref. So "cash refunded aug 10" is three filters, "maria" is a name, and
 * "cash maria" is both.
 *
 * Deliberately a deterministic parser, not a fuzzy or model-driven one: this
 * box drives money figures, and a search that quietly guesses wrong is worse
 * than one that ignores a word it does not know. Anything unrecognised falls
 * through to the text match, which is the old behaviour.
 */

export type PaymentsSearch = {
  /** 'card' | 'cash', or null for both. */
  tender: "card" | "cash" | null;
  /** Matches the badge on the row. 'refunded' also catches partial refunds. */
  status: "succeeded" | "refunded" | "partly_refunded" | "disputed" | null;
  /** A single NY day (YYYY-MM-DD) the user named, which narrows the range. */
  onDate: string | null;
  /** Whatever was left: the free-text match. */
  text: string;
  /** Human-readable labels for what was understood, for the "Reading:" hint. */
  labels: string[];
};

const TENDERS: Record<string, "card" | "cash"> = {
  cash: "cash",
  efectivo: "cash",
  card: "card",
  cards: "card",
  tarjeta: "card",
  credit: "card",
};

const STATUSES: Record<string, PaymentsSearch["status"]> = {
  refunded: "refunded",
  refund: "refunded",
  refunds: "refunded",
  reembolso: "refunded",
  voided: "refunded",
  void: "refunded",
  partial: "partly_refunded",
  partly: "partly_refunded",
  succeeded: "succeeded",
  success: "succeeded",
  successful: "succeeded",
  paid: "succeeded",
  disputed: "disputed",
  dispute: "disputed",
  chargeback: "disputed",
};

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const STATUS_LABELS: Record<NonNullable<PaymentsSearch["status"]>, string> = {
  succeeded: "Succeeded",
  refunded: "Refunded",
  partly_refunded: "Partly refunded",
  disputed: "Disputed",
};

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Shifts a YYYY-MM-DD by whole days without touching local time. */
function shiftISO(day: string, delta: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function labelDate(day: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T12:00:00Z`));
}

/**
 * @param q     what the user typed
 * @param today the current NY day (YYYY-MM-DD), used for "today"/"yesterday"
 *              and to pick the year when they write a month and day only.
 */
export function parsePaymentsSearch(q: string, today: string): PaymentsSearch {
  const out: PaymentsSearch = {
    tender: null,
    status: null,
    onDate: null,
    text: "",
    labels: [],
  };
  const trimmed = q.trim();
  if (!trimmed) return out;

  const defaultYear = Number(today.slice(0, 4));
  const tokens = trimmed.split(/\s+/);
  const leftover: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    const word = raw.toLowerCase().replace(/[.,]+$/, "");

    if (!out.tender && TENDERS[word]) {
      out.tender = TENDERS[word];
      continue;
    }
    if (!out.status && STATUSES[word]) {
      out.status = STATUSES[word];
      continue;
    }
    if (!out.onDate && (word === "today" || word === "hoy")) {
      out.onDate = today;
      continue;
    }
    if (!out.onDate && (word === "yesterday" || word === "ayer")) {
      out.onDate = shiftISO(today, -1);
      continue;
    }

    // 2026-08-10
    if (!out.onDate && /^\d{4}-\d{2}-\d{2}$/.test(word)) {
      out.onDate = word;
      continue;
    }
    // 8/10 or 8/10/2026 (US order, matching how the rows are displayed)
    const slash = word.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (!out.onDate && slash) {
      const m = Number(slash[1]);
      const d = Number(slash[2]);
      const y = slash[3]
        ? Number(slash[3].length === 2 ? `20${slash[3]}` : slash[3])
        : defaultYear;
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
        out.onDate = iso(y, m, d);
        continue;
      }
    }
    // "aug 10", "august 10 2026", or a bare "aug" (means the 1st onward is
    // ambiguous, so a lone month is left as text rather than guessed at).
    const month = MONTHS[word];
    if (!out.onDate && month) {
      const next = tokens[i + 1]?.replace(/[.,]+$/, "");
      const day = next && /^\d{1,2}$/.test(next) ? Number(next) : null;
      if (day && day >= 1 && day <= 31) {
        const after = tokens[i + 2]?.replace(/[.,]+$/, "");
        const year = after && /^\d{4}$/.test(after) ? Number(after) : defaultYear;
        out.onDate = iso(year, month, day);
        i += after && /^\d{4}$/.test(after) ? 2 : 1;
        continue;
      }
    }

    leftover.push(raw);
  }

  out.text = leftover.join(" ");
  if (out.tender) out.labels.push(out.tender === "cash" ? "Cash" : "Card");
  if (out.status) out.labels.push(STATUS_LABELS[out.status]);
  if (out.onDate) out.labels.push(labelDate(out.onDate));
  return out;
}
