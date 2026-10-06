"use client";

import { AlertTriangle, ArrowLeft, Clock } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  disputeReason,
  disputeStatus,
  disputeStatusExplainer,
  invokeStripeDisputes,
  type DisputeDetail,
} from "@/lib/payments/disputes";
import { daysLeftLabel, daysUntilNy, formatNyDate, formatNyDeadline, money } from "@/lib/payments/format";
import { useLiveRefresh } from "@/lib/realtime/use-live-refresh";
import { cn } from "@/lib/utils";

import { DisputeFacts } from "./dispute-facts";
import { EvidenceForm } from "./evidence-form";
import { EvidenceSummary } from "./evidence";

/** What the server knows from our copy, so the page paints before Stripe answers. */
export type DisputeHeader = {
  id: string;
  status: string;
  amount: number;
  currency: string;
  reason: string;
  customerName: string | null;
  businessName: string | null;
  dueBy: string | null;
  created: string;
};

export function DisputeDetailView({ header }: { header: DisputeHeader }) {
  const router = useRouter();
  const [detail, setDetail] = useState<DisputeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: loadError } = await invokeStripeDisputes<DisputeDetail>({
      action: "detail",
      dispute_id: header.id,
    });
    if (loadError || !data) setError(loadError ?? "Stripe did not answer.");
    else {
      setError(null);
      setDetail(data);
    }
  }, [header.id]);

  // Reloads when the status changes underneath (the webhook, or another tab):
  // the Realtime refresh re-renders the server page with the new status.
  useEffect(() => {
    void load();
  }, [load, header.status]);
  useLiveRefresh(`stripe-dispute-${header.id}`, [{ table: "stripe_disputes" }]);

  // Stripe settles some changes a moment later (a refund closes an inquiry within
  // seconds), so look again shortly after, as well as right away.
  const followUp = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (followUp.current) clearTimeout(followUp.current);
  }, []);

  const afterChange = useCallback(async () => {
    await load();
    router.refresh(); // the list's copy, the tab's count and the header follow
    if (followUp.current) clearTimeout(followUp.current);
    followUp.current = setTimeout(() => {
      void load().then(() => router.refresh());
    }, 8000);
  }, [load, router]);

  const status = detail?.dispute.status ?? header.status;
  const dueBy = detail?.dispute.dueBy ?? header.dueBy;
  const label = disputeStatus(status);

  return (
    <div className="space-y-6">
      <Link
        href="/admin/payments/disputes"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        All disputes
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">{header.customerName ?? "Card payment"}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {[header.businessName, disputeReason(header.reason), `Opened ${formatNyDate(header.created)}`]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-semibold tracking-tight">{money(header.amount, header.currency)}</p>
          <Badge tone={label.tone} className="mt-1">
            {label.label}
          </Badge>
        </div>
      </header>

      <StatusBanner status={status} dueBy={dueBy} amount={money(header.amount, header.currency)} pastDue={detail?.dispute.pastDue ?? false} />

      {error ? (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-5 text-sm">
            <p className="text-muted-foreground">
              Stripe did not answer, so the evidence cannot be shown. <span className="text-foreground">{error}</span>
            </p>
            <Button type="button" size="sm" variant="secondary" onClick={() => void load()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : !detail ? (
        <DetailSkeleton />
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div>
            {detail.dispute.answerable ? (
              <EvidenceForm detail={detail} onChanged={afterChange} />
            ) : (
              <EvidenceSummary detail={detail} />
            )}
          </div>
          <aside className="lg:sticky lg:top-4">
            <DisputeFacts detail={detail} />
          </aside>
        </div>
      )}
    </div>
  );
}

function StatusBanner({
  status,
  dueBy,
  amount,
  pastDue,
}: {
  status: string;
  dueBy: string | null;
  amount: string;
  pastDue: boolean;
}) {
  const waiting = status === "needs_response" || status === "warning_needs_response";
  const days = waiting && dueBy ? daysUntilNy(dueBy) : null;
  const urgent = waiting && (pastDue || (days != null && days <= 3));

  return (
    <div
      className={cn(
        "flex gap-3 rounded-lg border px-4 py-3 text-sm",
        waiting
          ? urgent
            ? "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
            : "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
          : "border-border bg-muted/40",
      )}
    >
      {waiting ? (
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      ) : (
        <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <div className="space-y-1">
        {waiting && dueBy && (
          <p className="font-semibold">
            {pastDue
              ? "The deadline has passed. Stripe may still take an answer, but send it now."
              : `Answer by ${formatNyDeadline(dueBy)}${days != null ? ` (${daysLeftLabel(days).toLowerCase()})` : ""}. If nothing is sent, the guest keeps the money.`}
          </p>
        )}
        <p>{disputeStatusExplainer(status, amount)}</p>
      </div>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-3">
        <span className="block h-6 w-40 animate-pulse rounded bg-muted" />
        <Card>
          <CardContent className="space-y-5 py-6">
            {[0, 1, 2].map((i) => (
              <div key={i} className="space-y-2">
                <span className="block h-4 w-32 animate-pulse rounded bg-muted" />
                <span className="block h-20 w-full animate-pulse rounded bg-muted" />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
      <div className="space-y-4">
        {[0, 1].map((i) => (
          <Card key={i}>
            <CardContent className="space-y-3 py-4">
              {[0, 1, 2, 3].map((j) => (
                <span key={j} className="block h-4 w-full animate-pulse rounded bg-muted" />
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
