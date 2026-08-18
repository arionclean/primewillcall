"use client";

import { useRouter } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatCentsExact, shiftDayISO } from "@/lib/dashboard/queries";

const NY_TZ = "America/New_York";

export type CajaItem = {
  kind: "cash" | "card";
  id: string;
  at: string;
  amountCents: number;
  refundedCents?: number;
  status: string | null;
  ok: boolean;
  label: string;
  method: string;
};

type Totals = {
  cashReceivedCents: number;
  cardGrossCents: number;
  cardRefundedCents: number;
  cashCount: number;
  cardCount: number;
};

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function dayLabel(day: string): string {
  // Noon avoids any date rollover when the browser renders the label.
  const d = new Date(`${day}T12:00:00`);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(d);
}

function timeLabel(iso: string): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TZ,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function CajaView({
  day,
  today,
  items,
  totals,
  kioskLabel,
  notice,
}: {
  day: string;
  today: string;
  items: CajaItem[];
  totals: Totals;
  kioskLabel?: string | null;
  notice?: string | null;
}) {
  const router = useRouter();

  const cardNetCents = totals.cardGrossCents - totals.cardRefundedCents;
  const madeCents = totals.cashReceivedCents + cardNetCents;
  const salesCount = totals.cashCount + totals.cardCount;

  const isToday = day === today;
  const go = (d: string) => router.push(`/caja?date=${d}`);

  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Caja</h1>
          <p className="text-sm text-muted-foreground">
            {kioskLabel ? `${kioskLabel} · ` : ""}Your sales for the day.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Previous day"
            onClick={() => go(shiftDayISO(day, -1))}
          >
            Prev
          </Button>
          <Input
            type="date"
            value={day}
            max={today}
            onChange={(e) => e.target.value && go(e.target.value)}
            className="h-9 w-[9.5rem]"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Next day"
            disabled={isToday}
            onClick={() => go(shiftDayISO(day, 1))}
          >
            Next
          </Button>
          {!isToday && (
            <Button type="button" size="sm" onClick={() => go(today)}>
              Today
            </Button>
          )}
        </div>
      </header>

      {notice && (
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {notice}
        </div>
      )}

      {/* How much you made */}
      <Card>
        <CardContent className="py-6">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {isToday ? "You made today" : `You made on ${dayLabel(day)}`}
          </p>
          <p className="mt-1 text-4xl font-bold tracking-tight tabular-nums">
            {formatCentsExact(madeCents)}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {salesCount} sale{salesCount === 1 ? "" : "s"}
          </p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-lg border p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Cash
              </p>
              <p className="mt-0.5 text-xl font-semibold tabular-nums">
                {formatCentsExact(totals.cashReceivedCents)}
              </p>
              <p className="text-xs text-muted-foreground">
                {totals.cashCount} sale{totals.cashCount === 1 ? "" : "s"}
              </p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Card
              </p>
              <p className="mt-0.5 text-xl font-semibold tabular-nums">
                {formatCentsExact(cardNetCents)}
              </p>
              <p className="text-xs text-muted-foreground">
                {totals.cardCount} sale{totals.cardCount === 1 ? "" : "s"}
                {totals.cardRefundedCents > 0
                  ? ` (less ${formatCentsExact(totals.cardRefundedCents)} refunded)`
                  : ""}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Sales list */}
      <h2 className="mb-2 mt-6 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {isToday ? "Today's sales" : `Sales on ${dayLabel(day)}`}
      </h2>
      {items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No sales yet.
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[38rem] text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-medium">Time</th>
                <th className="px-3 py-2 font-medium">Customer</th>
                <th className="px-3 py-2 font-medium">Payment</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={`${it.kind}-${it.id}`} className="border-b last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                    {timeLabel(it.at)}
                  </td>
                  <td className="max-w-[16rem] px-3 py-2">
                    <p className="truncate font-medium">{it.label}</p>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {it.kind === "cash" ? (
                      <Badge tone="success">Cash</Badge>
                    ) : (
                      <span className="text-muted-foreground">{it.method}</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">
                    {formatCentsExact(it.amountCents)}
                    {it.refundedCents ? (
                      <span className="block text-xs font-normal text-muted-foreground">
                        {"−"}
                        {formatCentsExact(it.refundedCents)}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge item={it} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ item }: { item: CajaItem }) {
  if (item.kind === "cash") {
    if (item.ok) return <Badge tone="success">Received</Badge>;
    if (item.status === "pending") return <Badge tone="warning">Pending</Badge>;
    return <Badge tone="danger">Failed</Badge>;
  }
  const refunded = item.refundedCents ?? 0;
  if (refunded > 0 && refunded >= item.amountCents) {
    return <Badge tone="neutral">Refunded</Badge>;
  }
  if (refunded > 0) return <Badge tone="warning">Partly refunded</Badge>;
  if (item.ok || item.status === "succeeded") {
    return <Badge tone="success">Went through</Badge>;
  }
  return <Badge tone="danger">{item.status ? cap(item.status) : "Failed"}</Badge>;
}
