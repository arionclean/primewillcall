"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useState,
  useTransition,
  type CSSProperties,
} from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  formatCents,
  formatCentsExact,
  nyDateISO,
  shiftDayISO,
} from "@/lib/dashboard/queries";
import type { Database } from "@/lib/supabase/database.types";

import { refundTransaction } from "./actions";

type StaffRole = Database["public"]["Enums"]["staff_role"];

type Txn = {
  id: string;
  stripe_id: string;
  business_id: string | null;
  amount: number;
  amount_refunded: number;
  currency: string;
  status: string | null;
  source: string | null;
  card_brand: string | null;
  card_last4: string | null;
  booking_id: string | null;
  booking_ref: string | null;
  customer_email: string | null;
  customer_name: string | null;
  receipt_url: string | null;
  stripe_created: string | null;
  object_type: string | null;
  business: { name: string } | null;
};

type CashSale = {
  id: string;
  business_id: string | null;
  booking_ref: string | null;
  amount_cents: number;
  kiosk_slug: string | null;
  created_at: string;
  customer_name: string | null;
  business: { name: string } | null;
};

export type FeedItem = (
  | ({ kind: "card" } & Txn)
  | ({ kind: "cash" } & CashSale)
) & {
  /** Deep link into /bookings (date + highlight) when the sale has a booking. */
  booking_href: string | null;
};

type Summary = {
  card_gross: number;
  card_count: number;
  refunded: number;
  cash_total: number;
  cash_count: number;
} | null;

// Non-kiosk channels; kiosk options come from the kiosks table (selling
// kiosks only) via props.
const CHANNEL_OPTIONS = [
  { value: "online", label: "Online" },
  { value: "groupon", label: "Groupon" },
];

/** "kiosk1" reads as "Kiosk 1"; any other slug is shown as-is. */
function kioskLabel(slug: string): string {
  const m = slug.match(/^kiosk(\d+)$/i);
  return m ? `Kiosk ${m[1]}` : slug;
}

type PaymentsViewProps = {
  role: StaffRole;
  paymentsConfigured: boolean;
  items: FeedItem[];
  summary: Summary;
  kiosks: string[];
  businesses: { id: string; name: string }[];
  filters: {
    from: string;
    to: string;
    business: string | null;
    q: string;
    source: string | null;
  };
};

const NY_TZ = "America/New_York";

// Date-range presets, computed in business time (America/New_York). "Custom"
// reveals the From/To inputs; every other choice applies its range directly.
const RANGE_PRESETS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "month", label: "This month" },
  { key: "lastMonth", label: "Last month" },
] as const;

type PresetKey = (typeof RANGE_PRESETS)[number]["key"] | "custom";

function presetRange(key: PresetKey): { from: string; to: string } | null {
  const today = nyDateISO();
  switch (key) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = shiftDayISO(today, -1);
      return { from: y, to: y };
    }
    case "7d":
      return { from: shiftDayISO(today, -6), to: today };
    case "30d":
      return { from: shiftDayISO(today, -29), to: today };
    case "month":
      return { from: `${today.slice(0, 8)}01`, to: today };
    case "lastMonth": {
      const firstOfThis = `${today.slice(0, 8)}01`;
      const lastOfPrev = shiftDayISO(firstOfThis, -1);
      return { from: `${lastOfPrev.slice(0, 8)}01`, to: lastOfPrev };
    }
    default:
      return null;
  }
}

function detectPreset(from: string, to: string): PresetKey {
  for (const p of RANGE_PRESETS) {
    const range = presetRange(p.key);
    if (range && range.from === from && range.to === to) return p.key;
  }
  return "custom";
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TZ,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The customer line; a dashed underline marks it as a link to the booking. */
function CustomerName({
  label,
  href,
}: {
  label: string;
  href: string | null;
}) {
  if (!href) return <p className="truncate font-medium">{label}</p>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="block truncate font-medium underline decoration-dashed underline-offset-4 hover:decoration-solid"
    >
      {label}
    </a>
  );
}

/** "Visa ···· 4242", "···· 8215", or "Card" when Stripe sent no card details. */
function cardLabel(txn: Txn): string {
  if (!txn.card_last4) return txn.card_brand ? capitalize(txn.card_brand) : "Card";
  const brand = txn.card_brand ? `${capitalize(txn.card_brand)} ` : "";
  return `${brand}···· ${txn.card_last4}`;
}

/**
 * Who the charge belongs to. Online charges carry the cardholder name; kiosk
 * card-present charges have no name on the charge, so fall back to the sale
 * reference the POS stamped in metadata (KS-...).
 */
function customerLabel(txn: Txn): { primary: string; secondary: string } {
  const primary =
    txn.customer_name ??
    txn.customer_email ??
    (txn.booking_ref ? `Sale ${txn.booking_ref}` : "Card customer");
  const secondary = [txn.source, txn.business?.name].filter(Boolean).join(" · ");
  return { primary, secondary };
}

function statusBadge(txn: Txn): { label: string; tone: "success" | "warning" | "danger" | "neutral" | "info" } {
  if (txn.status === "disputed") return { label: "Disputed", tone: "danger" };
  const refunded = txn.amount_refunded ?? 0;
  if (refunded > 0 && refunded >= txn.amount) return { label: "Refunded", tone: "neutral" };
  if (refunded > 0) return { label: "Partly refunded", tone: "warning" };
  if (txn.status === "succeeded") return { label: "Succeeded", tone: "success" };
  return { label: txn.status ?? "—", tone: "info" };
}

export function PaymentsView({
  role,
  paymentsConfigured,
  items,
  summary,
  kiosks,
  businesses,
  filters,
}: PaymentsViewProps) {
  const router = useRouter();
  const [from, setFrom] = useState(filters.from);
  const [to, setTo] = useState(filters.to);
  const [preset, setPreset] = useState<PresetKey>(() =>
    detectPreset(filters.from, filters.to),
  );
  const [business, setBusiness] = useState(filters.business ?? "");
  const [source, setSource] = useState(filters.source ?? "");
  const [q, setQ] = useState(filters.q);
  const [isPending, startTransition] = useTransition();

  // Refund dialog state. `refundFor` doubles as the open/closed flag.
  const [refundFor, setRefundFor] = useState<Txn | null>(null);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundPin, setRefundPin] = useState("");
  const [refundError, setRefundError] = useState<string | null>(null);

  // Filters apply on change (no Apply button). Handlers pass the value they
  // just set as an override because React state updates are async.
  const pushFilters = useCallback(
    (
      overrides: Partial<{
        from: string;
        to: string;
        business: string;
        source: string;
        q: string;
      }> = {},
    ) => {
      const v = { from, to, business, source, q: q.trim(), ...overrides };
      const params = new URLSearchParams();
      if (v.from) params.set("from", v.from);
      if (v.to) params.set("to", v.to);
      if (v.business) params.set("business", v.business);
      if (v.source) params.set("source", v.source);
      if (v.q) params.set("q", v.q);
      router.push(`/admin/payments?${params.toString()}`);
    },
    [from, to, business, source, q, router],
  );

  // Search applies as you type, debounced; Enter applies immediately.
  useEffect(() => {
    const term = q.trim();
    if (term === filters.q) return;
    const t = setTimeout(() => pushFilters({ q: term }), 400);
    return () => clearTimeout(t);
  }, [q, filters.q, pushFilters]);

  function onPresetChange(key: PresetKey) {
    setPreset(key);
    const range = presetRange(key);
    if (!range) return; // custom: reveal From/To, they apply on change
    setFrom(range.from);
    setTo(range.to);
    pushFilters({ from: range.from, to: range.to });
  }

  function openRefund(txn: Txn) {
    setRefundFor(txn);
    setRefundAmount("");
    setRefundPin("");
    setRefundError(null);
  }

  function submitRefund() {
    if (!refundFor) return;
    const remaining = refundFor.amount - (refundFor.amount_refunded ?? 0);
    const cents = Math.round(Number.parseFloat(refundAmount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      setRefundError("Enter a refund amount.");
      return;
    }
    if (cents > remaining) {
      setRefundError(
        `The most you can refund is ${formatCentsExact(remaining, refundFor.currency)}.`,
      );
      return;
    }
    if (!refundPin.trim()) {
      setRefundError("Enter the refund passcode.");
      return;
    }
    setRefundError(null);
    startTransition(async () => {
      const res = await refundTransaction(refundFor.id, cents, refundPin.trim());
      if (res.error) {
        setRefundError(res.error);
        return;
      }
      setRefundFor(null);
      router.refresh();
    });
  }

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Payments</h1>
      </header>

      <SummaryCards summary={summary} />

      <div className="mt-6 mb-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          Search
          <Input
            type="search"
            placeholder="Name, email, last4, or sale ref"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") pushFilters({ q: q.trim() });
            }}
            className="h-9 w-[16rem]"
          />
        </label>
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
        {preset === "custom" && (
          <>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              From
              <Input
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  if (e.target.value) pushFilters({ from: e.target.value });
                }}
                className="h-9 w-[9.5rem]"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              To
              <Input
                type="date"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  if (e.target.value) pushFilters({ to: e.target.value });
                }}
                className="h-9 w-[9.5rem]"
              />
            </label>
          </>
        )}
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          Source
          <Select
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              pushFilters({ source: e.target.value });
            }}
            className="h-9 w-[9rem]"
          >
            <option value="">All sources</option>
            {kiosks.map((slug) => (
              <option key={slug} value={slug}>
                {kioskLabel(slug)}
              </option>
            ))}
            {CHANNEL_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </label>
        {role === "owner" && businesses.length > 0 && (
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Business
            <Select
              value={business}
              onChange={(e) => {
                setBusiness(e.target.value);
                pushFilters({ business: e.target.value });
              }}
              className="h-9 w-[12rem]"
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

      {items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No sales in this range.
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[46rem] text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">Payment</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                if (item.kind === "cash") {
                  const secondary = [item.kiosk_slug, item.business?.name]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <tr key={`cash-${item.id}`} className="border-b last:border-0">
                      <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                        {formatDateTime(item.created_at)}
                      </td>
                      <td className="max-w-[16rem] px-3 py-2">
                        <CustomerName
                          label={
                            item.customer_name ??
                            (item.booking_ref
                              ? `Sale ${item.booking_ref}`
                              : "Cash sale")
                          }
                          href={item.booking_href}
                        />
                        {secondary && (
                          <p className="truncate text-xs text-muted-foreground">
                            {secondary}
                          </p>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">
                        <Badge tone="success">Cash</Badge>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right font-medium">
                        {formatCentsExact(item.amount_cents)}
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone="success">Succeeded</Badge>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right text-muted-foreground">
                        —
                      </td>
                    </tr>
                  );
                }
                const txn = item;
                const badge = statusBadge(txn);
                const card = cardLabel(txn);
                const customer = customerLabel(txn);
                const refundable =
                  paymentsConfigured &&
                  txn.object_type === "charge" &&
                  txn.status !== "disputed" &&
                  txn.amount - (txn.amount_refunded ?? 0) > 0;
                return (
                  <tr key={txn.id} className="border-b last:border-0">
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                      {formatDateTime(txn.stripe_created)}
                    </td>
                    <td className="max-w-[16rem] px-3 py-2">
                      <CustomerName
                        label={customer.primary}
                        href={txn.booking_href}
                      />
                      {customer.secondary && (
                        <p className="truncate text-xs text-muted-foreground">
                          {customer.secondary}
                        </p>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                      {card}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-medium">
                      {formatCentsExact(txn.amount, txn.currency)}
                      {txn.amount_refunded > 0 && (
                        <span className="block text-xs font-normal text-muted-foreground">
                          −{formatCentsExact(txn.amount_refunded, txn.currency)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-3">
                        {txn.receipt_url && (
                          <a
                            href={txn.receipt_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-primary underline-offset-4 hover:underline"
                          >
                            Receipt
                          </a>
                        )}
                        {refundable && (
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            onClick={() => openRefund(txn)}
                          >
                            Refund
                          </Button>
                        )}
                        {!txn.receipt_url && !refundable && (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {items.length >= 200 && (
        <p className="mt-3 text-xs text-muted-foreground">
          Showing the 200 most recent sales in this range. Narrow the dates to
          see older ones. (Totals above cover the full range.)
        </p>
      )}

      {refundFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <Card className="w-full max-w-sm">
            <CardContent className="py-5">
              <h2 className="text-base font-semibold">
                Refund {customerLabel(refundFor).primary}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Up to{" "}
                {formatCentsExact(
                  refundFor.amount - (refundFor.amount_refunded ?? 0),
                  refundFor.currency,
                )}{" "}
                goes back to the card. This cannot be undone.
              </p>

              <div className="mt-4 flex flex-col gap-3">
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                  <span className="flex items-center justify-between">
                    Amount
                    <button
                      type="button"
                      className="font-medium text-blue-600 hover:underline"
                      onClick={() =>
                        setRefundAmount(
                          (
                            (refundFor.amount - (refundFor.amount_refunded ?? 0)) /
                            100
                          ).toFixed(2),
                        )
                      }
                    >
                      Max{" "}
                      {formatCentsExact(
                        refundFor.amount - (refundFor.amount_refunded ?? 0),
                        refundFor.currency,
                      )}
                    </button>
                  </span>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min="0.01"
                    step="0.01"
                    placeholder="0.00"
                    value={refundAmount}
                    onChange={(e) => setRefundAmount(e.target.value)}
                    className="h-9"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                  Refund passcode
                  {/* Plain text input masked via CSS: type="password" (or the
                      one-time-code hint) makes Safari/1Password offer to
                      autofill or save it, which makes no sense for this pin. */}
                  <Input
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    name="refund-code"
                    data-1p-ignore=""
                    data-lpignore="true"
                    style={{ WebkitTextSecurity: "disc" } as CSSProperties}
                    value={refundPin}
                    onChange={(e) => setRefundPin(e.target.value)}
                    className="h-9"
                  />
                </label>
              </div>

              {refundError && (
                <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {refundError}
                </p>
              )}

              <div className="mt-4 flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={isPending}
                  onClick={() => setRefundFor(null)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={
                    isPending || !refundAmount.trim() || !refundPin.trim()
                  }
                  onClick={submitRefund}
                >
                  {isPending ? "Refunding…" : "Refund"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function SummaryCards({ summary }: { summary: Summary }) {
  const cardGross = summary?.card_gross ?? 0;
  const cardCount = summary?.card_count ?? 0;
  const cashTotal = summary?.cash_total ?? 0;
  const cashCount = summary?.cash_count ?? 0;
  const refunded = summary?.refunded ?? 0;
  const total = cardGross + cashTotal;
  const count = cardCount + cashCount;

  const cards: { label: string; value: string; hint?: string }[] = [
    { label: "Gross", value: formatCents(total), hint: `${count} sale${count === 1 ? "" : "s"}` },
    { label: "Card", value: formatCents(cardGross), hint: `${cardCount} charge${cardCount === 1 ? "" : "s"}` },
    { label: "Cash", value: formatCents(cashTotal), hint: `${cashCount} sale${cashCount === 1 ? "" : "s"}` },
    { label: "Refunded", value: formatCents(refunded) },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {cards.map((c) => (
        <Card key={c.label}>
          <CardContent className="py-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {c.label}
            </p>
            <p className="mt-1 text-xl font-semibold tracking-tight">{c.value}</p>
            {c.hint && <p className="text-xs text-muted-foreground">{c.hint}</p>}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
