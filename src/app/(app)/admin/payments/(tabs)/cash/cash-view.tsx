"use client";

import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { useActionState, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatCents, formatCentsExact, nyDateISO } from "@/lib/dashboard/queries";
import {
  RANGE_PRESETS,
  detectPreset,
  presetRange,
  type PresetKey,
} from "@/lib/payments/date-range";
import { useLiveRefresh } from "@/lib/realtime/use-live-refresh";

import {
  completeNight,
  saveNightFigure,
  type CompleteState,
  type FigureState,
} from "./actions";

/** One kiosk's night: what the desk counted next to what the system recorded. */
export type CloseRow = {
  closing_id: string | null;
  business_date: string;
  kiosk_id: string | null;
  kiosk_slug: string;
  business_id: string | null;
  business_name: string | null;
  /** A close exists, whether the tablet sent it or the owner typed it. */
  closed: boolean;
  entered_manually: boolean;
  closed_by_name: string | null;
  closed_at: string | null;
  /** What the tablet reported. Null when nothing was reported. */
  counted_cash_cents: number | null;
  /** The owner's correction to the count. Null means the report stands. */
  counted_cash_cents_corrected: number | null;
  /** The number the owner believes: the correction if there is one. */
  effective_counted_cash_cents: number | null;
  system_cash_cents: number;
  system_cash_count: number;
  system_card_cents: number;
  /** Before refunds. The close report is gross, so that is what it compares to. */
  system_card_gross_cents: number;
  system_card_count: number;
  /** The card total the desk reported. Null on a hand-entered night. */
  reported_card_cents: number | null;
  /** Sales that came in after the night was closed. The tell for an early close. */
  after_close_count: number;
  after_close_cents: number;
  commission_cents: number | null;
  commission_cents_corrected: number | null;
  effective_commission_cents: number;
  correction_note: string | null;
  reviewed_at: string | null;
  reviewed_by_name: string | null;
  to_collect_cents: number | null;
  /** System minus the effective count. Positive means less cash than sales. */
  diff_cents: number;
};

type Business = { id: string; name: string };

/** "kiosk1" reads as "Kiosk 1" for anyone who does not work in the database. */
function kioskLabel(slug: string): string {
  const m = slug.match(/^kiosk(\d+)$/i);
  return m ? `Kiosk ${m[1]}` : slug.charAt(0).toUpperCase() + slug.slice(1);
}

/** A plain date string, as "Sat, Sep 20". Parsed as UTC so it never shifts a day. */
function dayLabel(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(d);
}

/** A close timestamp as the desk would say it: "12:09 PM", in business time. */
function closeTime(iso: string | null): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** Cents into the text an owner would type back: "1307.00", or "" for nothing. */
function moneyInput(cents: number | null | undefined): string {
  return cents == null ? "" : (cents / 100).toFixed(2);
}

export function CashCloseView({
  isOwner,
  nights,
  businesses,
  filters,
}: {
  isOwner: boolean;
  nights: CloseRow[];
  businesses: Business[];
  filters: { from: string; to: string; business: string };
}) {
  const router = useRouter();

  // A cash sale landing late (the sweep runs every five minutes) or a reprinted
  // close both change what this screen says, so it watches both tables and lets
  // the server component fetch the answer.
  useLiveRefresh("payments-cash-close", [
    { table: "cash_sales" },
    { table: "kiosk_closings" },
  ]);

  const preset = detectPreset(filters.from, filters.to);

  function pushFilters(next: Partial<typeof filters>) {
    const merged = { ...filters, ...next };
    const params = new URLSearchParams();
    params.set("from", merged.from);
    params.set("to", merged.to);
    if (merged.business) params.set("business", merged.business);
    router.push(`/admin/payments/cash?${params.toString()}`);
  }

  function onPresetChange(key: PresetKey) {
    const range = presetRange(key);
    if (range) pushFilters(range);
  }

  const today = nyDateISO();

  // Totals over the rows on screen. One row per kiosk per day, so a month is a
  // couple of hundred numbers: summing them here is not the fetch-all-and-sum
  // the aggregation rule warns about, and it guarantees the header always
  // describes exactly the nights listed under it.
  const systemCash = nights.reduce((s, n) => s + n.system_cash_cents, 0);
  const commission = nights.reduce((s, n) => s + n.effective_commission_cents, 0);
  const toCollect = nights.reduce(
    (s, n) => s + n.system_cash_cents - n.effective_commission_cents,
    0,
  );
  // Counted from the same verdict the Check column shows, so the header always
  // matches the red and amber badges under it. A night merely waiting for the
  // owner's sign-off is ordinary business, not a problem.
  const needsLook = nights.filter((n) =>
    PROBLEM_CHECKS.has(nightCheck(n, n.business_date === today).kind),
  ).length;
  const dayCount = new Set(nights.map((n) => n.business_date)).size;

  const cards = [
    {
      label: "Cash in system",
      value: formatCents(systemCash),
      hint: `${dayCount} day${dayCount === 1 ? "" : "s"}`,
    },
    { label: "Commission", value: formatCents(commission), hint: "Paid out at the desk" },
    { label: "Cash to collect", value: formatCents(toCollect), hint: "Counted less commission" },
    {
      label: "Needs a look",
      value: String(needsLook),
      hint: needsLook === 0 ? "Nothing off" : "Numbers off or never closed",
      alert: needsLook > 0,
    },
  ];

  // Rows arrive newest first, kiosks in order, so grouping is a single pass.
  const days: { date: string; rows: CloseRow[] }[] = [];
  for (const n of nights) {
    const last = days[days.length - 1];
    if (last && last.date === n.business_date) last.rows.push(n);
    else days.push({ date: n.business_date, rows: [n] });
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {cards.map((c) => (
          <Card key={c.label}>
            <CardContent className="py-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {c.label}
              </p>
              <p
                className={
                  c.alert
                    ? "mt-1 text-xl font-semibold tracking-tight text-red-600"
                    : "mt-1 text-xl font-semibold tracking-tight"
                }
              >
                {c.value}
              </p>
              <p className="text-xs text-muted-foreground">{c.hint}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="mt-6 mb-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          Range
          <Select
            value={preset}
            onChange={(e) => onPresetChange(e.target.value as PresetKey)}
            className="h-9 w-[10rem]"
          >
            {RANGE_PRESETS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
            <option value="custom">Custom</option>
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          From
          <Input
            type="date"
            value={filters.from}
            max={filters.to}
            onChange={(e) => e.target.value && pushFilters({ from: e.target.value })}
            className="h-9 w-[9.5rem]"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          To
          <Input
            type="date"
            value={filters.to}
            min={filters.from}
            onChange={(e) => e.target.value && pushFilters({ to: e.target.value })}
            className="h-9 w-[9.5rem]"
          />
        </label>
        {businesses.length > 1 && (
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Business
            <Select
              value={filters.business}
              onChange={(e) => pushFilters({ business: e.target.value })}
              className="h-9 w-[13rem]"
            >
              <option value="">All businesses</option>
              {businesses.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </label>
        )}
      </div>

      {nights.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No cash and no closings in this range.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {days.map((day) => (
            <section key={day.date}>
              <h2 className="mb-2 text-sm font-semibold">{dayLabel(day.date)}</h2>
              <Card>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                        <tr>
                          <th className="px-4 py-2.5 text-left font-medium">Kiosk</th>
                          <th className="px-4 py-2.5 text-right font-medium">Sales</th>
                          <th className="px-4 py-2.5 text-right font-medium">Card</th>
                          <th className="px-4 py-2.5 text-right font-medium">Cash in system</th>
                          <th className="px-4 py-2.5 text-right font-medium">Commission</th>
                          <th className="px-4 py-2.5 text-right font-medium">Cash to collect</th>
                          <th className="px-4 py-2.5 text-right font-medium">Received</th>
                          <th className="px-4 py-2.5 text-left font-medium">Check</th>
                          {isOwner && <th className="px-4 py-2.5" />}
                        </tr>
                      </thead>
                      <tbody>
                        {day.rows.map((n) => (
                          <NightRow
                            key={`${n.business_date}-${n.kiosk_slug}`}
                            night={n}
                            isOwner={isOwner}
                            isToday={n.business_date === today}
                            showBusiness={businesses.length > 1}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function NightRow({
  night,
  isOwner,
  isToday,
  showBusiness,
}: {
  night: CloseRow;
  isOwner: boolean;
  isToday: boolean;
  showBusiness: boolean;
}) {
  const salesCount = night.system_card_count + night.system_cash_count;

  return (
    <tr className="border-b last:border-0">
      <td className="px-4 py-3">
        <p className="font-medium">{kioskLabel(night.kiosk_slug)}</p>
        <p className="text-xs text-muted-foreground">
          {showBusiness && night.business_name ? night.business_name : ""}
          {showBusiness && night.business_name && night.closed ? " · " : ""}
          {night.entered_manually
            ? "Entered by hand"
            : night.closed
              ? `${
                  night.closed_by_name ? `Closed by ${night.closed_by_name}` : "Closed"
                }${closeTime(night.closed_at) ? ` at ${closeTime(night.closed_at)}` : ""}`
              : ""}
        </p>
      </td>
      <td className="px-4 py-3 text-right font-medium tabular-nums">
        {formatCentsExact(night.system_card_cents + night.system_cash_cents)}
        <span className="block text-xs font-normal text-muted-foreground">
          {salesCount} sale{salesCount === 1 ? "" : "s"}
        </span>
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        {formatCentsExact(night.system_card_cents)}
        <span className="block text-xs text-muted-foreground">
          {night.system_card_count} charge{night.system_card_count === 1 ? "" : "s"}
        </span>
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        {formatCentsExact(night.system_cash_cents)}
        <span className="block text-xs text-muted-foreground">
          {night.system_cash_count} sale{night.system_cash_count === 1 ? "" : "s"}
        </span>
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        <FigureCell night={night} field="commission" editable={isOwner && !isToday} />
      </td>
      <td className="px-4 py-3 text-right font-medium tabular-nums">
        {formatCentsExact(night.system_cash_cents - night.effective_commission_cents)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        <FigureCell night={night} field="received" editable={isOwner && !isToday} />
      </td>
      <td className="px-4 py-3">
        <CheckBadge night={night} isToday={isToday} />
      </td>
      {isOwner && (
        <td className="px-4 py-3">
          <div className="flex justify-end">
            {!night.reviewed_at && !isToday && <CompleteButton night={night} />}
          </div>
        </td>
      )}
    </tr>
  );
}

/**
 * A figure typed straight into the row, the commission or the cash received:
 * click it, type, Enter (or click away) to save, Escape to leave it. Tonight
 * stays read-only because its close still belongs to the tablet.
 */
function FigureCell({
  night,
  field,
  editable,
}: {
  night: CloseRow;
  field: "commission" | "received";
  editable: boolean;
}) {
  const [editing, setEditing] = useState(false);
  // Held in state, not left to the input: React resets a form after its action
  // runs, which would wipe the amount just typed when the save is refused.
  const [value, setValue] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  // Enter saves and the blur that follows would save again. One per edit.
  const sentRef = useRef(false);
  const [state, action, pending] = useActionState<FigureState, FormData>(
    async (prev, formData) => {
      const result = await saveNightFigure(prev, formData);
      if (result.saved) setEditing(false);
      else sentRef.current = false;
      return result;
    },
    {},
  );

  const owed = night.system_cash_cents - night.effective_commission_cents;
  let cents: number | null;
  let was: number | null = null;
  if (field === "commission") {
    const corrected = night.commission_cents_corrected != null;
    cents =
      night.commission_cents != null || corrected ? night.effective_commission_cents : null;
    if (corrected) was = night.commission_cents;
  } else {
    cents = night.counted_cash_cents_corrected;
  }
  const current = moneyInput(cents);
  const label = field === "commission" ? "Commission" : "Received";

  const display =
    cents == null ? (
      <span className="text-muted-foreground">-</span>
    ) : (
      <>
        {formatCentsExact(cents)}
        {was != null && (
          <span className="block text-xs text-amber-700">was {formatCentsExact(was)}</span>
        )}
      </>
    );

  if (!editable) return display;

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          sentRef.current = false;
          setValue(current);
          setEditing(true);
        }}
        title={
          field === "commission"
            ? "Click to enter the commission"
            : "Click to enter the cash received"
        }
        className="-mx-2 -my-1 rounded-md px-2 py-1 text-right tabular-nums hover:bg-muted"
      >
        {display}
      </button>
    );
  }

  function submitIfChanged() {
    if (sentRef.current) return;
    sentRef.current = true;
    if (value.trim() === current) setEditing(false);
    else formRef.current?.requestSubmit();
  }

  return (
    <form ref={formRef} action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="field" value={field} />
      <input type="hidden" name="closing_id" value={night.closing_id ?? ""} />
      <input type="hidden" name="kiosk_id" value={night.kiosk_id ?? ""} />
      <input type="hidden" name="kiosk_slug" value={night.kiosk_slug} />
      <input type="hidden" name="business_id" value={night.business_id ?? ""} />
      <input type="hidden" name="business_date" value={night.business_date} />
      <Input
        name="amount"
        type="text"
        inputMode="decimal"
        // The cash owed is the answer on most nights, so it is the hint.
        placeholder={field === "received" ? moneyInput(owed) : "0.00"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label={label}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onBlur={submitIfChanged}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submitIfChanged();
          } else if (e.key === "Escape") {
            sentRef.current = true;
            setEditing(false);
          }
        }}
        readOnly={pending}
        className="h-8 w-24 text-right tabular-nums"
      />
      {state.error && <span className="max-w-40 text-xs text-red-600">{state.error}</span>}
    </form>
  );
}

/**
 * Closes the book on a night. Received left blank is taken as exactly what was
 * owed; one the owner typed stands, and any gap shows as a warning afterwards.
 */
function CompleteButton({ night }: { night: CloseRow }) {
  const [state, action] = useActionState<CompleteState, FormData>(completeNight, {});
  return (
    <form action={action}>
      <input type="hidden" name="kiosk_id" value={night.kiosk_id ?? ""} />
      <input type="hidden" name="kiosk_slug" value={night.kiosk_slug} />
      <input type="hidden" name="business_id" value={night.business_id ?? ""} />
      <input type="hidden" name="business_date" value={night.business_date} />
      <SubmitButton size="sm" variant="secondary" title={state.error ?? undefined}>
        Complete
      </SubmitButton>
    </form>
  );
}

type NightCheck =
  | { kind: "completed"; gap: number }
  | { kind: "open" }
  | { kind: "never_closed" }
  | { kind: "short" | "over"; cents: number }
  | { kind: "changed_after_close"; cents: number }
  | { kind: "pending" };

/** The checks that put a night in the "Needs a look" count. */
const PROBLEM_CHECKS = new Set<NightCheck["kind"]>([
  "never_closed",
  "short",
  "over",
  "changed_after_close",
]);

/**
 * One verdict per night, shared by the Check column and the header count. A
 * completed night comes first: the owner has closed the book on it, so a gap
 * between received and owed is recorded, not something left to act on.
 */
function nightCheck(night: CloseRow, isToday: boolean): NightCheck {
  const owed = night.system_cash_cents - night.effective_commission_cents;
  const received = night.counted_cash_cents_corrected;
  if (night.reviewed_at) return { kind: "completed", gap: (received ?? owed) - owed };
  if (!night.closed) return isToday ? { kind: "open" } : { kind: "never_closed" };

  if (received != null) {
    if (received < owed) return { kind: "short", cents: owed - received };
    if (received > owed) return { kind: "over", cents: received - owed };
    return { kind: "pending" };
  }

  // Nothing received yet, so the tablet's own cash total is the only check. It
  // is the same sales list the system holds, so a gap means the list moved
  // after the close: a sale voided or refunded later, or one that never arrived.
  const reported = night.counted_cash_cents;
  if (reported != null && reported !== night.system_cash_cents) {
    return {
      kind: "changed_after_close",
      cents: Math.abs(reported - night.system_cash_cents),
    };
  }

  // Money in hand is not the same as the owner having dealt with the night, so
  // anything not completed stays open business.
  return { kind: "pending" };
}

function CheckBadge({ night, isToday }: { night: CloseRow; isToday: boolean }) {
  const check = nightCheck(night, isToday);
  switch (check.kind) {
    case "completed":
      return (
        <div className="flex flex-col items-start gap-1">
          <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700">
            Completed
          </Badge>
          {check.gap !== 0 && (
            <span className="flex items-center gap-1 whitespace-nowrap text-xs text-amber-700">
              <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
              Collected {formatCentsExact(Math.abs(check.gap))}{" "}
              {check.gap < 0 ? "less" : "more"}
            </span>
          )}
        </div>
      );
    case "open":
      return <Badge className="border-slate-200 bg-slate-50 text-slate-600">Still open</Badge>;
    case "never_closed":
      return <Badge className="border-amber-200 bg-amber-50 text-amber-800">Never closed</Badge>;
    case "short":
    case "over":
      return (
        <Badge className="border-red-200 bg-red-50 text-red-700">
          {check.kind === "short" ? "Short" : "Over"} {formatCentsExact(check.cents)}
        </Badge>
      );
    case "changed_after_close":
      return (
        <Badge className="border-amber-200 bg-amber-50 text-amber-800">
          Changed after close: {formatCentsExact(check.cents)}
        </Badge>
      );
    case "pending":
      return <Badge className="border-sky-200 bg-sky-50 text-sky-700">Pending</Badge>;
  }
}
