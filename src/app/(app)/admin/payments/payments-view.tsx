"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { formatCents } from "@/lib/dashboard/queries";
import type { Database } from "@/lib/supabase/database.types";

import { refundTransaction } from "./actions";

type StaffRole = Database["public"]["Enums"]["staff_role"];

type Txn = {
  id: string;
  stripe_id: string;
  business_id: string | null;
  amount: number;
  net: number;
  stripe_fee: number;
  application_fee: number;
  amount_refunded: number;
  currency: string;
  status: string | null;
  source: string | null;
  card_brand: string | null;
  booking_id: string | null;
  customer_email: string | null;
  receipt_url: string | null;
  stripe_created: string | null;
  object_type: string | null;
  business: { name: string } | null;
};

type Summary = {
  gross: number;
  net: number;
  stripe_fees: number;
  application_fees: number;
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
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function applyFilters() {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (business) params.set("business", business);
    router.push(`/admin/payments?${params.toString()}`);
  }

  function onRefund(txn: Txn) {
    const remaining = txn.amount - (txn.amount_refunded ?? 0);
    const ok = window.confirm(
      `Refund ${formatCents(remaining, txn.currency)} to the customer? This cannot be undone.`,
    );
    if (!ok) return;
    setError(null);
    setBusyId(txn.id);
    startTransition(async () => {
      const res = await refundTransaction(txn.id);
      setBusyId(null);
      if (res.error) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Payments</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Card charges settled through Stripe. Totals are for the selected range.
        </p>
      </header>

      {!paymentsConfigured && (
        <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Payments are not configured yet. Set STRIPE_SECRET_KEY (and the webhook
          secrets) to record charges and enable refunds.
        </p>
      )}

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

      {error && (
        <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

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
                {role === "owner" && <th className="px-3 py-2 font-medium">Business</th>}
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 text-right font-medium">Fees</th>
                <th className="px-3 py-2 text-right font-medium">Net</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((txn) => {
                const badge = statusBadge(txn);
                const fees = (txn.stripe_fee ?? 0) + (txn.application_fee ?? 0);
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
                    {role === "owner" && (
                      <td className="px-3 py-2">{txn.business?.name ?? "—"}</td>
                    )}
                    <td className="max-w-[12rem] truncate px-3 py-2">
                      {txn.customer_email ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-medium">
                      {formatCents(txn.amount, txn.currency)}
                      {txn.amount_refunded > 0 && (
                        <span className="block text-xs font-normal text-muted-foreground">
                          −{formatCents(txn.amount_refunded, txn.currency)}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right text-muted-foreground">
                      {formatCents(fees, txn.currency)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {formatCents(txn.net, txn.currency)}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                    </td>
                    <td className="px-3 py-2 capitalize text-muted-foreground">
                      {txn.source ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {refundable ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          disabled={isPending && busyId === txn.id}
                          onClick={() => onRefund(txn)}
                        >
                          {isPending && busyId === txn.id ? "Refunding…" : "Refund"}
                        </Button>
                      ) : txn.receipt_url ? (
                        <a
                          href={txn.receipt_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-primary underline-offset-4 hover:underline"
                        >
                          Receipt
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
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
    </div>
  );
}

function SummaryCards({ summary }: { summary: Summary }) {
  const gross = summary?.gross ?? 0;
  const net = summary?.net ?? 0;
  const fees = (summary?.stripe_fees ?? 0) + (summary?.application_fees ?? 0);
  const refunded = summary?.refunded ?? 0;
  const count = summary?.txn_count ?? 0;

  const cards: { label: string; value: string; hint?: string }[] = [
    { label: "Gross", value: formatCents(gross), hint: `${count} charge${count === 1 ? "" : "s"}` },
    { label: "Net", value: formatCents(net), hint: "after fees" },
    { label: "Fees", value: formatCents(fees), hint: "Stripe + platform" },
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
