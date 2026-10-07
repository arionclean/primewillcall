"use client";

import { AlertTriangle, ChevronDown, ChevronRight, ExternalLink, Landmark, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { formatCents, formatCentsExact } from "@/lib/dashboard/queries";
import { bookingHref, formatDay, formatNyDate, formatNyDateTime, formatNyDeadline, money } from "@/lib/payments/format";
import {
  invokeStripeReports,
  payoutStatus,
  saleSourceLabel,
  STRIPE_CONNECT_PRICING_URL,
  STRIPE_PRICING_URL,
  stripeAccountUrl,
  type BusinessOverview,
  type Overview,
  type PayoutDetail,
  type PayoutLine,
} from "@/lib/payments/stripe-reports";
import { useLiveRefresh } from "@/lib/realtime/use-live-refresh";
import { cn } from "@/lib/utils";

export type PayoutRow = {
  id: string;
  businessId: string | null;
  businessName: string | null;
  amount: number;
  currency: string;
  status: string;
  /** YYYY-MM-DD, the day Stripe expects it in the bank. */
  arrivalDate: string;
  automatic: boolean;
  instant: boolean;
  bankName: string | null;
  bankLast4: string | null;
  failureMessage: string | null;
};

/** Disputes waiting for an answer, so the Payouts tab can point at the Disputes tab. */
export type OpenDisputes = { count: number; amount: number; soonestDue: string | null };

type Props = {
  openDisputes: OpenDisputes;
  payouts: PayoutRow[];
  businesses: { id: string; name: string }[];
  business: string | null;
  page: number;
  perPage: number;
  total: number;
};

// ── Formatting ───────────────────────────────────────────────────────────────

function bankLabel(p: Pick<PayoutRow, "bankName" | "bankLast4">): string | null {
  if (!p.bankLast4) return null;
  const name = p.bankName
    ? p.bankName.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
    : "Bank";
  return `${name} •••• ${p.bankLast4}`;
}

// ── The screen ───────────────────────────────────────────────────────────────

export function PayoutsView({
  openDisputes,
  payouts,
  businesses,
  business,
  page,
  perPage,
  total,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Stripe's live answers. Loaded after the page paints: the history below is
  // ours and shows at once, the balance and health take a second or two.
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    setOverviewError(null);
    const { data, error } = await invokeStripeReports<Overview>({ action: "overview" });
    if (error) setOverviewError(error);
    else setOverview(data);
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  // A payout that lands or changes status redraws the list. The overview itself
  // writes the latest payouts on open, so the first refresh usually comes from it.
  useLiveRefresh("stripe-payouts", [{ table: "stripe_payouts" }]);

  const go = (params: { business?: string | null; page?: number }) => {
    const sp = new URLSearchParams();
    const b = params.business === undefined ? business : params.business;
    if (b) sp.set("business", b);
    const p = params.page ?? 1;
    if (p > 1) sp.set("page", String(p));
    const qs = sp.toString();
    startTransition(() => router.push(`/admin/payments/payouts${qs ? `?${qs}` : ""}`));
  };

  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const firstRow = total === 0 ? 0 : (page - 1) * perPage + 1;
  const lastRow = Math.min(page * perPage, total);

  return (
    <div className="space-y-8">
      {openDisputes.count > 0 && <OpenDisputesBanner open={openDisputes} />}

      <section>
        {overviewError ? (
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 py-5 text-sm">
              <p className="text-muted-foreground">
                Stripe did not answer, so balances and account status are not shown.{" "}
                <span className="text-foreground">{overviewError}</span>
              </p>
              <Button type="button" size="sm" variant="secondary" onClick={() => void loadOverview()}>
                Try again
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {overview
              ? overview.businesses.map((b) => (
                  <BusinessCard key={b.id} business={b} />
                ))
              : businesses.map((b) => <BusinessCardSkeleton key={b.id} name={b.name} />)}
          </div>
        )}
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Payouts</h2>
            <p className="text-sm text-muted-foreground">
              Money Stripe sent to each business&apos;s bank. Open one to see the sales in it.
            </p>
          </div>
          {businesses.length > 1 && (
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Business
              <Select
                value={business ?? ""}
                onChange={(e) => go({ business: e.target.value || null })}
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

        {payouts.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No payouts yet.
            </CardContent>
          </Card>
        ) : (
          <PayoutsTable payouts={payouts} showBusiness={!business && businesses.length > 1} />
        )}

        {total > 0 && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Showing {firstRow.toLocaleString()} to {lastRow.toLocaleString()} of{" "}
              {total.toLocaleString()} {total === 1 ? "payout" : "payouts"}
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
      </section>
    </div>
  );
}

// ── Business cards ───────────────────────────────────────────────────────────

const HEALTH_BADGE = {
  ok: { label: "All good", tone: "success" },
  attention: { label: "Needs attention", tone: "warning" },
  blocked: { label: "Paused", tone: "danger" },
} as const;

/**
 * One business: everything Stripe will send to its bank, then when. The total is
 * the money still clearing plus anything already cleared, plus a payout already
 * sent and not yet arrived; the lines split it into the next payout and the rest.
 */
function BusinessCard({ business: b }: { business: BusinessOverview }) {
  const next = b.nextPayout;
  const balance = (b.balance?.pending ?? 0) + (b.balance?.available ?? 0);
  // A sent payout has left the balance, so it is added back; a scheduled one is
  // still inside it.
  const total = balance + (next?.onTheWay ? next.amount : 0);
  const later = next ? total - next.amount : 0;
  return (
    <Card className="h-full">
      <CardContent className="flex h-full flex-col gap-4 py-5">
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-semibold leading-tight">{b.name}</h3>
          {b.health && (
            <Badge tone={HEALTH_BADGE[b.health.level].tone}>{HEALTH_BADGE[b.health.level].label}</Badge>
          )}
        </div>

        {b.error ? (
          <p className="text-sm text-muted-foreground">
            Stripe could not be read for this business. {b.error}
          </p>
        ) : (
          <>
            {b.health && b.health.messages.length > 0 && (
              <div
                className={cn(
                  "rounded-md border px-3 py-2 text-sm",
                  b.health.level === "blocked"
                    ? "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
                    : "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
                )}
              >
                {b.health.messages.map((m) => (
                  <p key={m}>{m}</p>
                ))}
                {b.health.deadline && <p className="mt-1 font-medium">Due by {formatNyDate(b.health.deadline)}.</p>}
                <Link
                  href={`/admin/businesses/${b.id}`}
                  className="mt-1 inline-block font-medium underline underline-offset-4"
                >
                  Fix it in the business settings
                </Link>
              </div>
            )}

            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Coming to the bank
              </p>
              <p className="mt-1 text-2xl font-semibold tracking-tight">{formatCents(total)}</p>
            </div>

            <div className="space-y-1 border-t pt-3 text-sm">
              {next ? (
                <>
                  <p className="flex justify-between gap-3">
                    <span className="text-muted-foreground">
                      {formatDay(next.date)}
                      {next.onTheWay && " (on the way)"}
                    </span>
                    <span className="font-medium">{formatCentsExact(next.amount)}</span>
                  </p>
                  {later > 0 && (
                    <p className="flex justify-between gap-3">
                      <span className="text-muted-foreground">Later</span>
                      <span className="font-medium">{formatCentsExact(later)}</span>
                    </p>
                  )}
                </>
              ) : (
                <p className="text-muted-foreground">
                  {next === null ? "Nothing on the way right now" : "Payout dates are not available right now"}
                </p>
              )}
              {b.previous.map((p) => (
                <p key={p.accountId} className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Left on the old Stripe account</span>
                  <span className="font-medium">{formatCentsExact(p.available + p.pending)}</span>
                </p>
              ))}
            </div>
          </>
        )}

        {/* The business's account in Prime's own Stripe dashboard, in a new tab. */}
        <a
          href={stripeAccountUrl(b.accountId)}
          target="_blank"
          rel="noreferrer"
          className="mt-auto inline-flex items-center gap-1 self-start text-xs text-muted-foreground/60 hover:text-muted-foreground"
        >
          Open in Stripe
          <ExternalLink className="size-3" aria-hidden />
        </a>
      </CardContent>
    </Card>
  );
}

function BusinessCardSkeleton({ name }: { name: string }) {
  return (
    <Card>
      <CardContent className="space-y-4 py-5">
        <div className="flex items-start justify-between gap-3">
          <h3 className="font-semibold leading-tight">{name}</h3>
          <span className="h-5 w-16 animate-pulse rounded-full bg-muted" />
        </div>
        <div className="space-y-2">
          <span className="block h-3 w-32 animate-pulse rounded bg-muted" />
          <span className="block h-7 w-28 animate-pulse rounded bg-muted" />
        </div>
        <div className="space-y-2 border-t pt-3">
          <span className="block h-4 w-full animate-pulse rounded bg-muted" />
          <span className="block h-4 w-2/3 animate-pulse rounded bg-muted" />
        </div>
      </CardContent>
    </Card>
  );
}

// ── Disputes waiting ─────────────────────────────────────────────────────────

function OpenDisputesBanner({ open }: { open: OpenDisputes }) {
  return (
    <Link
      href="/admin/payments/disputes"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 transition hover:bg-red-100 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200 dark:hover:bg-red-950/60"
    >
      <span className="flex items-center gap-2">
        <AlertTriangle className="size-4 shrink-0" aria-hidden />
        <span>
          {open.count === 1 ? "1 dispute needs" : `${open.count} disputes need`} an answer
          {open.soonestDue ? `, the first by ${formatNyDeadline(open.soonestDue)}` : ""}.{" "}
          {formatCentsExact(open.amount)} is on hold.
        </span>
      </span>
      <span className="font-medium underline underline-offset-4">Answer in Disputes</span>
    </Link>
  );
}

// ── Payouts and what is in them ──────────────────────────────────────────────

function PayoutsTable({ payouts, showBusiness }: { payouts: PayoutRow[]; showBusiness: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null);
  // Fetched once per payout per visit: what is inside a paid payout never changes.
  const [details, setDetails] = useState<Record<string, PayoutDetail | { error: string } | undefined>>({});

  const toggle = async (id: string) => {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    if (details[id] && !("error" in details[id]!)) return;
    setDetails((d) => ({ ...d, [id]: undefined }));
    const { data, error } = await invokeStripeReports<PayoutDetail>({
      action: "payout_detail",
      payout_id: id,
    });
    setDetails((d) => ({ ...d, [id]: error || !data ? { error: error ?? "No answer from Stripe." } : data }));
  };

  const columns = showBusiness ? 6 : 5;

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[40rem] text-sm">
        <thead>
          <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="w-8 px-3 py-2" />
            <th className="px-3 py-2 font-medium">Arrives</th>
            {showBusiness && <th className="px-3 py-2 font-medium">Business</th>}
            <th className="px-3 py-2 font-medium">Bank</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody>
          {payouts.map((p) => {
            const status = payoutStatus(p.status);
            const isOpen = openId === p.id;
            const bank = bankLabel(p);
            return (
              <Fragment key={p.id}>
                <tr
                  className={cn(
                    "cursor-pointer border-b last:border-0 hover:bg-muted/30",
                    isOpen && "bg-muted/30",
                  )}
                  onClick={() => void toggle(p.id)}
                >
                  <td className="px-3 py-2 text-muted-foreground">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-label={isOpen ? "Hide what is in this payout" : "Show what is in this payout"}
                      className="flex items-center"
                      onClick={(e) => {
                        e.stopPropagation();
                        void toggle(p.id);
                      }}
                    >
                      {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                    </button>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {formatDay(p.arrivalDate)}
                    {p.instant && <span className="ml-2 text-xs text-muted-foreground">Instant</span>}
                  </td>
                  {showBusiness && <td className="px-3 py-2">{p.businessName ?? "Unknown"}</td>}
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                    {bank ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Landmark className="size-3.5" aria-hidden />
                        {bank}
                      </span>
                    ) : (
                      "Earlier bank account"
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={status.tone}>{status.label}</Badge>
                    {p.failureMessage && (
                      <p className="mt-1 text-xs text-red-700 dark:text-red-300">{p.failureMessage}</p>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-medium">
                    {formatCentsExact(p.amount, p.currency)}
                  </td>
                </tr>
                {isOpen && (
                  <tr className="border-b last:border-0">
                    <td colSpan={columns} className="bg-muted/20 px-3 py-4 sm:px-6">
                      <PayoutContents payout={p} detail={details[p.id]} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const KIND_LABEL: Record<PayoutLine["kind"], string> = {
  sale: "Sale",
  refund: "Refund",
  dispute: "Dispute",
  other: "Other",
};

function PayoutContents({
  payout,
  detail,
}: {
  payout: PayoutRow;
  detail: PayoutDetail | { error: string } | undefined;
}) {
  if (!detail) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Asking Stripe what went into this payout…
      </p>
    );
  }
  if ("error" in detail) {
    return <p className="text-sm text-muted-foreground">Stripe could not list this payout. {detail.error}</p>;
  }
  if (detail.note) return <p className="text-sm text-muted-foreground">{detail.note}</p>;
  if (detail.lines.length === 0) {
    return <p className="text-sm text-muted-foreground">Stripe lists nothing in this payout.</p>;
  }

  const sales = detail.lines.filter((l) => l.kind === "sale");
  const refunds = detail.lines.filter((l) => l.kind === "refund");
  const disputes = detail.lines.filter((l) => l.kind === "dispute");
  const fees = detail.lines.reduce((s, l) => s + l.fee, 0);
  const stripeFees = detail.lines.reduce((s, l) => s + l.stripeFee, 0);
  const primeFees = detail.lines.reduce((s, l) => s + l.platformFee, 0);
  const net = detail.lines.reduce((s, l) => s + l.net, 0);
  const sum = (lines: PayoutLine[]) => lines.reduce((s, l) => s + l.amount, 0);

  const totals: { label: string; value: string }[] = [
    { label: `${sales.length} sale${sales.length === 1 ? "" : "s"}`, value: money(sum(sales)) },
    ...(refunds.length > 0
      ? [{ label: `${refunds.length} refund${refunds.length === 1 ? "" : "s"}`, value: money(sum(refunds)) }]
      : []),
    ...(disputes.length > 0
      ? [{ label: `${disputes.length} dispute${disputes.length === 1 ? "" : "s"}`, value: money(sum(disputes)) }]
      : []),
    { label: "Fees", value: money(-fees) },
    { label: "Sent to the bank", value: money(net) },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {totals.map((t) => (
          <div key={t.label}>
            <p className="text-xs text-muted-foreground">{t.label}</p>
            <p className="font-semibold">{t.value}</p>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Fees: {formatCentsExact(stripeFees)} to <ExternalText href={STRIPE_PRICING_URL}>Stripe</ExternalText>,{" "}
        {formatCentsExact(primeFees)}{" "}
        <ExternalText href={STRIPE_CONNECT_PRICING_URL}>payout volume fee</ExternalText>.
        {net !== payout.amount && !detail.truncated && (
          <> These lines add up to {money(net)}, not the payout&apos;s {formatCentsExact(payout.amount)}.</>
        )}
        {detail.truncated && <> Showing the first {detail.lines.length.toLocaleString()} lines.</>}
      </p>

      <div className="overflow-x-auto rounded-md border bg-background">
        <table className="w-full min-w-[38rem] text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Guest</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 text-right font-medium">Amount</th>
              <th className="px-3 py-2 text-right font-medium">Fees</th>
              <th className="px-3 py-2 text-right font-medium">Net</th>
            </tr>
          </thead>
          <tbody>
            {detail.lines.map((l) => {
              const secondary = [saleSourceLabel(l.source), l.bookingRef?.startsWith("KS-") ? l.bookingRef : null]
                .filter(Boolean)
                .join(" · ");
              return (
                <tr key={l.id} className="border-b last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                    {formatNyDateTime(l.created)}
                  </td>
                  <td className="max-w-[16rem] px-3 py-2">
                    <GuestName
                      label={l.customerName ?? l.description ?? KIND_LABEL[l.kind]}
                      href={bookingHref(l.bookingId, l.bookingStartsAt)}
                    />
                    {secondary && <p className="truncate text-xs text-muted-foreground">{secondary}</p>}
                  </td>
                  <td className="px-3 py-2">
                    {l.kind === "sale" ? (
                      <span className="text-muted-foreground">Sale</span>
                    ) : (
                      <Badge tone={l.kind === "other" ? "neutral" : "warning"}>{KIND_LABEL[l.kind]}</Badge>
                    )}
                  </td>
                  <td
                    className={cn(
                      "whitespace-nowrap px-3 py-2 text-right",
                      l.amount < 0 && "text-red-700 dark:text-red-300",
                    )}
                  >
                    {money(l.amount)}
                  </td>
                  <td
                    className="whitespace-nowrap px-3 py-2 text-right text-muted-foreground"
                    title={`${formatCentsExact(l.stripeFee)} to Stripe, ${formatCentsExact(l.platformFee)} payout volume fee`}
                  >
                    {l.fee ? money(-l.fee) : "None"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-medium">{money(l.net)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Inline text that opens a page outside the app in a new tab. */
function ExternalText({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline underline-offset-2 hover:text-foreground"
    >
      {children}
    </a>
  );
}

function GuestName({ label, href }: { label: string; href: string | null }) {
  if (!href) return <p className="truncate font-medium">{label}</p>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="block truncate font-medium underline decoration-dashed decoration-muted-foreground/50 underline-offset-4 hover:decoration-solid hover:decoration-muted-foreground"
    >
      {label}
    </a>
  );
}
