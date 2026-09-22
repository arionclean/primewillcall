"use client";

import { useRouter } from "next/navigation";
import { useMemo, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { downloadCsv } from "@/lib/csv";
import { formatCents } from "@/lib/dashboard/queries";
import { useLiveRefresh } from "@/lib/realtime/use-live-refresh";
import { cn } from "@/lib/utils";

import { decimalHours, formatMinutes } from "./hours-range";
import { RangeBar } from "./range-bar";

export type SellerTotal = {
  /** Null for the sales nobody can be credited with. */
  employeeId: string | null;
  name: string;
  /** Sales that still count: a sale refunded in full drops out. */
  sales: number;
  /** Each net of its refunds. */
  cashCents: number;
  cardCents: number;
  /** Minutes on the time clock in the range; 0 when they did not clock in. */
  minutes: number;
};

type Props = {
  /** Highest total first. */
  people: SellerTotal[];
  /** Tablet sales with no PIN on them; null when every sale has one. */
  uncredited: SellerTotal | null;
  /** Every business, and somebody on the clock: Hours and Per hour. */
  showHours: boolean;
  /** For the business filter, shown when there is more than one. */
  businesses: { id: string; name: string }[];
  filters: { from: string; to: string; business: string };
  loadError: boolean;
};

const total = (r: SellerTotal) => r.cashCents + r.cardCents;

/** What they took for each hour on the clock; null when there are no hours to divide by. */
function perHourCents(r: SellerTotal): number | null {
  return r.minutes > 0 ? Math.round((total(r) * 60) / r.minutes) : null;
}

/** Cents as plain dollars for a spreadsheet: 123456 -> "1234.56". */
const dollars = (cents: number) => (cents / 100).toFixed(2);

export function SalesView({
  people,
  uncredited,
  showHours,
  businesses,
  filters,
  loadError,
}: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const { from, to, business } = filters;

  // A sale, a refund or a void anywhere redraws the numbers without a reload.
  useLiveRefresh("team-sales", [
    { table: "cash_sales" },
    { table: "stripe_transactions" },
    { table: "stripe_refunds" },
    ...(showHours ? [{ table: "time_clock_shifts" }] : []),
  ]);

  function go(next: Partial<Props["filters"]>) {
    const f = { ...filters, ...next };
    const params = new URLSearchParams({ from: f.from, to: f.to });
    if (f.business) params.set("business", f.business);
    startTransition(() => router.push(`/admin/staff/sales?${params.toString()}`));
  }

  // The people, then the sales nobody can be credited with, so the Total row is
  // every tablet sale in the range.
  const rows = useMemo(
    () => (uncredited ? [...people, uncredited] : people),
    [people, uncredited],
  );
  const sum = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({
          sales: acc.sales + r.sales,
          cashCents: acc.cashCents + r.cashCents,
          cardCents: acc.cardCents + r.cardCents,
          minutes: acc.minutes + r.minutes,
        }),
        { sales: 0, cashCents: 0, cardCents: 0, minutes: 0 },
      ),
    [rows],
  );

  function exportCsv() {
    const header = ["Person", "Sales", "Cash", "Card", "Total"];
    if (showHours) header.push("Hours", "Per hour");
    downloadCsv(
      from === to ? `sales-${from}.csv` : `sales-${from}_to_${to}.csv`,
      header,
      rows.map((r) => {
        const cells: (string | number)[] = [
          r.employeeId ? r.name : "Not credited to anyone",
          r.sales,
          dollars(r.cashCents),
          dollars(r.cardCents),
          dollars(total(r)),
        ];
        if (showHours) {
          const perHour = perHourCents(r);
          cells.push(r.minutes > 0 ? decimalHours(r.minutes) : "", perHour === null ? "" : dollars(perHour));
        }
        return cells;
      }),
    );
  }

  const columns = showHours ? 7 : 5;

  return (
    <div className="space-y-6">
      {loadError && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Could not load the sales. Refresh the page and try again.
        </p>
      )}

      <RangeBar from={from} to={to} onRange={(f, t) => go({ from: f, to: t })}>
        {businesses.length > 1 && (
          <Select
            value={business}
            onChange={(e) => go({ business: e.target.value })}
            aria-label="Business"
            className="h-8 w-[12rem] text-xs"
          >
            <option value="">All businesses</option>
            {businesses.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={exportCsv}
          disabled={rows.length === 0}
          className="ml-auto"
        >
          Export CSV
        </Button>
      </RangeBar>

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs font-medium text-muted-foreground">
                <th className="px-4 py-2.5">Person</th>
                <th className="px-4 py-2.5 text-right">Sales</th>
                {/* Cash and card step aside on a phone; the total is the answer. */}
                <th className="hidden px-4 py-2.5 text-right sm:table-cell">Cash</th>
                <th className="hidden px-4 py-2.5 text-right sm:table-cell">Card</th>
                <th className="px-4 py-2.5 text-right">Total</th>
                {showHours && (
                  <>
                    <th className="hidden px-4 py-2.5 text-right sm:table-cell">Hours</th>
                    <th className="px-4 py-2.5 text-right">Per hour</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={columns} className="px-4 py-8 text-center text-muted-foreground">
                    No tablet sales in this range.
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const perHour = perHourCents(r);
                  const nobody = r.employeeId === null;
                  return (
                    <tr
                      key={r.employeeId ?? "uncredited"}
                      className={cn("border-b last:border-0", nobody && "text-muted-foreground")}
                    >
                      <td className="px-4 py-2.5">
                        {nobody ? (
                          <>
                            <span>Not credited to anyone</span>
                            <span className="block text-xs">
                              No PIN was typed, or the person was removed
                            </span>
                          </>
                        ) : (
                          <span className="font-medium">{r.name}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                        {r.sales}
                      </td>
                      <td className="hidden px-4 py-2.5 text-right tabular-nums text-muted-foreground sm:table-cell">
                        {formatCents(r.cashCents)}
                      </td>
                      <td className="hidden px-4 py-2.5 text-right tabular-nums text-muted-foreground sm:table-cell">
                        {formatCents(r.cardCents)}
                      </td>
                      <td
                        className={cn(
                          "px-4 py-2.5 text-right tabular-nums",
                          !nobody && "font-medium",
                        )}
                      >
                        {formatCents(total(r))}
                      </td>
                      {showHours && (
                        <>
                          <td className="hidden px-4 py-2.5 text-right tabular-nums text-muted-foreground sm:table-cell">
                            {r.minutes > 0 ? formatMinutes(r.minutes) : ""}
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums">
                            {perHour === null ? "" : formatCents(perHour)}
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
            {rows.length > 1 && (
              <tfoot>
                <tr className="border-t bg-muted/40">
                  <td className="px-4 py-2.5 font-medium">Total</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-medium">{sum.sales}</td>
                  <td className="hidden px-4 py-2.5 text-right tabular-nums font-medium sm:table-cell">
                    {formatCents(sum.cashCents)}
                  </td>
                  <td className="hidden px-4 py-2.5 text-right tabular-nums font-medium sm:table-cell">
                    {formatCents(sum.cardCents)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-semibold tabular-nums">
                    {formatCents(sum.cashCents + sum.cardCents)}
                  </td>
                  {showHours && (
                    <>
                      <td className="hidden px-4 py-2.5 text-right tabular-nums font-medium sm:table-cell">
                        {formatMinutes(sum.minutes)}
                      </td>
                      <td className="px-4 py-2.5" />
                    </>
                  )}
                </tr>
              </tfoot>
            )}
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
