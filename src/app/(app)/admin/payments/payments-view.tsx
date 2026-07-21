"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { formatCents, formatCentsExact } from "@/lib/dashboard/queries";
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

type Summary = {
  gross: number;
  refunded: number;
  txn_count: number;
} | null;

type PaymentsViewProps = {
  role: StaffRole;
  paymentsConfigured: boolean;
  transactions: Txn[];
  summary: Summary;
  businesses: { id: string; name: string }[];
  filters: { from: string; to: string; business: string | null };
};

const NY_TZ = "America/New_York";

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

/** "Visa ···· 4242", "···· 8215", or null when Stripe sent no card details. */
function cardLabel(txn: Txn): string | null {
  if (!txn.card_last4) return txn.card_brand ? capitalize(txn.card_brand) : null;
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
  transactions,
  summary,
  businesses,
  filters,
}: PaymentsViewProps) {
  const router = useRouter();
  const [from, setFrom] = useState(filters.from);
  const [to, setTo] = useState(filters.to);
  const [business, setBusiness] = useState(filters.business ?? "");
  const [isPending, startTransition] = useTransition();

  // Refund dialog state. `refundFor` doubles as the open/closed flag.
  const [refundFor, setRefundFor] = useState<Txn | null>(null);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundPin, setRefundPin] = useState("");
  const [refundError, setRefundError] = useState<string | null>(null);

  function applyFilters() {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (business) params.set("business", business);
    router.push(`/admin/payments?${params.toString()}`);
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
          From
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-9 w-[9.5rem]"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
          To
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-9 w-[9.5rem]"
          />
        </label>
        {role === "owner" && businesses.length > 0 && (
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Business
            <Select
              value={business}
              onChange={(e) => setBusiness(e.target.value)}
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
        <Button type="button" variant="outline" onClick={applyFilters}>
          Apply
        </Button>
      </div>

      {transactions.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No charges in this range.
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[46rem] text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">Card</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((txn) => {
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
                      <p className="truncate font-medium">{customer.primary}</p>
                      {customer.secondary && (
                        <p className="truncate text-xs text-muted-foreground">
                          {customer.secondary}
                        </p>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                      {card ?? "—"}
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

      {transactions.length >= 200 && (
        <p className="mt-3 text-xs text-muted-foreground">
          Showing the 200 most recent charges in this range. Narrow the dates to
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
                  <Input
                    type="password"
                    inputMode="numeric"
                    autoComplete="one-time-code"
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
  const gross = summary?.gross ?? 0;
  const refunded = summary?.refunded ?? 0;
  const count = summary?.txn_count ?? 0;

  const cards: { label: string; value: string; hint?: string }[] = [
    { label: "Gross", value: formatCents(gross), hint: `${count} charge${count === 1 ? "" : "s"}` },
    { label: "Refunded", value: formatCents(refunded) },
  ];

  return (
    <div className="grid grid-cols-2 gap-3">
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
