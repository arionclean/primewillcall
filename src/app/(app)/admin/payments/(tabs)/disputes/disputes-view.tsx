"use client";

import { ChevronRight, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { SEGMENT, SEGMENT_ITEM, SEGMENT_OFF, SEGMENT_ON } from "@/components/ui/segment";
import { formatCentsExact } from "@/lib/dashboard/queries";
import {
  disputeReason,
  disputeStatus,
  invokeStripeDisputes,
  type DisputeBucket,
} from "@/lib/payments/disputes";
import { daysLeftLabel, daysUntilNy, formatNyDate, formatNyDeadline } from "@/lib/payments/format";
import { useLiveRefresh } from "@/lib/realtime/use-live-refresh";
import { cn } from "@/lib/utils";

export type DisputeFilter = DisputeBucket | "all";

export type DisputeListRow = {
  id: string;
  businessName: string | null;
  amount: number;
  currency: string;
  status: string;
  reason: string;
  networkReasonCode: string | null;
  cardBrand: string | null;
  dueBy: string | null;
  pastDue: boolean;
  customerName: string | null;
  created: string;
};

type Props = {
  disputes: DisputeListRow[];
  summary: Partial<Record<DisputeBucket, { count: number; amount: number }>>;
  filter: DisputeFilter;
  business: string | null;
  businesses: { id: string; name: string }[];
  page: number;
  perPage: number;
  total: number;
};

const FILTERS: { value: DisputeFilter; label: string }[] = [
  { value: "needs_response", label: "Needs an answer" },
  { value: "under_review", label: "Waiting on the bank" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
  { value: "closed", label: "Other closed" },
  { value: "all", label: "All" },
];

const EMPTY: Record<DisputeFilter, string> = {
  needs_response: "Nothing needs an answer right now.",
  under_review: "No disputes are waiting on a bank.",
  won: "No disputes won yet.",
  lost: "No disputes lost.",
  closed: "No other closed disputes.",
  all: "No disputes. When a guest asks their bank for the money back, it shows up here.",
};

type SyncState = { state: "checking" } | { state: "done"; at: Date } | { state: "error"; message: string };

export function DisputesView({ disputes, summary, filter, business, businesses, page, perPage, total }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Our list is a copy. Ask Stripe for anything new each time the tab opens; any
  // row that changes comes back over Realtime and redraws the page.
  const [sync, setSync] = useState<SyncState>({ state: "checking" });
  const runSync = useCallback(async () => {
    setSync({ state: "checking" });
    const { error } = await invokeStripeDisputes<{ ok: boolean }>({ action: "sync" });
    setSync(error ? { state: "error", message: error } : { state: "done", at: new Date() });
  }, []);
  useEffect(() => {
    void runSync();
  }, [runSync]);

  useLiveRefresh("stripe-disputes", [{ table: "stripe_disputes" }]);

  const go = (params: { status?: DisputeFilter; business?: string | null; page?: number }) => {
    const sp = new URLSearchParams();
    sp.set("status", params.status ?? filter);
    const b = params.business === undefined ? business : params.business;
    if (b) sp.set("business", b);
    const p = params.page ?? 1;
    if (p > 1) sp.set("page", String(p));
    startTransition(() => router.push(`/admin/payments/disputes?${sp.toString()}`));
  };

  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const firstRow = total === 0 ? 0 : (page - 1) * perPage + 1;
  const lastRow = Math.min(page * perPage, total);

  const cards: { bucket: DisputeBucket; label: string; hint: (amount: string) => string; tone?: string }[] = [
    {
      bucket: "needs_response",
      label: "Needs an answer",
      hint: (a) => `${a} on hold`,
      tone: "text-red-700 dark:text-red-300",
    },
    { bucket: "under_review", label: "Waiting on the bank", hint: (a) => `${a} on hold` },
    { bucket: "won", label: "Won", hint: (a) => `${a} recovered` },
    { bucket: "lost", label: "Lost", hint: (a) => `${a} lost` },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((c) => {
          const s = summary[c.bucket] ?? { count: 0, amount: 0 };
          const active = filter === c.bucket;
          return (
            <button
              key={c.bucket}
              type="button"
              onClick={() => go({ status: c.bucket })}
              className={cn(
                "rounded-xl border bg-card px-4 py-4 text-left shadow-sm transition hover:border-foreground/20",
                active && "border-indigo-600 ring-1 ring-indigo-600",
              )}
            >
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{c.label}</p>
              <p className={cn("mt-1 text-xl font-semibold tracking-tight", s.count > 0 && c.tone)}>{s.count}</p>
              <p className="text-xs text-muted-foreground">{c.hint(formatCentsExact(s.amount))}</p>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className={cn(SEGMENT, "flex-wrap")} role="tablist" aria-label="Filter disputes">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                role="tab"
                aria-selected={filter === f.value}
                onClick={() => go({ status: f.value })}
                className={cn(SEGMENT_ITEM, filter === f.value ? SEGMENT_ON : SEGMENT_OFF)}
              >
                {f.label}
              </button>
            ))}
          </div>
          {businesses.length > 1 && (
            <Select
              aria-label="Business"
              value={business ?? ""}
              onChange={(e) => go({ business: e.target.value || null })}
              className="h-8 w-[13rem] text-xs"
            >
              <option value="">All businesses</option>
              {businesses.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          )}
        </div>
        <SyncStatus sync={sync} onRetry={() => void runSync()} />
      </div>

      {disputes.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">{EMPTY[filter]}</CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[44rem] text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-medium">Guest</th>
                <th className="px-3 py-2 font-medium">Reason</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Deadline</th>
                <th className="w-8 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {disputes.map((d) => (
                <DisputeRow key={d.id} dispute={d} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Showing {firstRow.toLocaleString()} to {lastRow.toLocaleString()} of {total.toLocaleString()}{" "}
            {total === 1 ? "dispute" : "disputes"}
          </p>
          {pageCount > 1 && (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={page <= 1 || isPending}
                onClick={() => go({ page: page - 1 })}
              >
                Previous
              </Button>
              <span className="px-1 text-xs text-muted-foreground">
                Page {page.toLocaleString()} of {pageCount.toLocaleString()}
              </span>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={page >= pageCount || isPending}
                onClick={() => go({ page: page + 1 })}
              >
                Next
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DisputeRow({ dispute: d }: { dispute: DisputeListRow }) {
  const router = useRouter();
  const href = `/admin/payments/disputes/${d.id}`;
  const status = disputeStatus(d.status);
  const waiting = status.tone === "danger";
  const days = waiting && d.dueBy ? daysUntilNy(d.dueBy) : null;
  const urgent = days != null && days <= 3;

  return (
    <tr
      className="cursor-pointer border-b last:border-0 hover:bg-muted/30"
      onClick={() => router.push(href)}
    >
      <td className="max-w-[15rem] px-3 py-2">
        <Link href={href} className="block truncate font-medium" onClick={(e) => e.stopPropagation()}>
          {d.customerName ?? "Card payment"}
        </Link>
        <p className="truncate text-xs text-muted-foreground">{d.businessName ?? "Unknown business"}</p>
      </td>
      <td className="px-3 py-2">
        {disputeReason(d.reason)}
        {d.networkReasonCode && (
          <p className="text-xs text-muted-foreground">
            {d.cardBrand ? `${d.cardBrand[0].toUpperCase()}${d.cardBrand.slice(1)} ` : ""}code {d.networkReasonCode}
          </p>
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-right font-medium">{formatCentsExact(d.amount, d.currency)}</td>
      <td className="px-3 py-2">
        <Badge tone={status.tone}>{status.label}</Badge>
      </td>
      <td className="whitespace-nowrap px-3 py-2">
        {waiting && d.dueBy ? (
          <span className={cn(urgent && "font-medium text-red-700 dark:text-red-300")}>
            {formatNyDeadline(d.dueBy)}
            {days != null && <span className="block text-xs text-muted-foreground">{daysLeftLabel(days)}</span>}
          </span>
        ) : (
          <span className="text-muted-foreground">Opened {formatNyDate(d.created)}</span>
        )}
      </td>
      <td className="px-3 py-2 text-muted-foreground">
        <ChevronRight className="size-4" aria-hidden />
      </td>
    </tr>
  );
}

function SyncStatus({ sync, onRetry }: { sync: SyncState; onRetry: () => void }) {
  if (sync.state === "checking") {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <RefreshCw className="size-3.5 animate-spin" aria-hidden />
        Checking Stripe for changes
      </p>
    );
  }
  if (sync.state === "error") {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        Could not check Stripe. {sync.message}
        <button type="button" onClick={onRetry} className="font-medium text-foreground underline underline-offset-2">
          Try again
        </button>
      </p>
    );
  }
  return <p className="text-xs text-muted-foreground">Up to date with Stripe</p>;
}
