"use client";

import { CreditCard, ExternalLink, RefreshCw, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  cancelFeeFreeMigration,
  createConnectAccount,
  createLoginLink,
  createOnboardingLink,
  refreshAccountStatus,
  startFeeFreeMigration,
  switchToLegacyAccount,
  switchToPendingAccount,
  type PaymentsActionResult,
} from "./payments-actions";

type BusinessPaymentsFields = {
  id: string;
  stripe_account_id: string | null;
  stripe_charges_enabled: boolean;
  stripe_payouts_enabled: boolean;
  stripe_details_submitted: boolean;
  stripe_requirements_due: number;
  stripe_account_id_pending: string | null;
  stripe_account_id_legacy: string[];
  stripe_fees_payer: string | null;
};

type StripeConnectPanelProps = {
  business: BusinessPaymentsFields;
  /** Live status of the pending fee-free account, when a migration is running. */
  pending: {
    id: string;
    chargesEnabled: boolean;
    detailsSubmitted: boolean;
    requirementsDue: number;
  } | null;
  paymentsConfigured: boolean;
  /** Global platform fee in basis points (0.25% = 25), shown read-only. */
  feeBps: number;
  /** True when the page loaded from a Stripe onboarding return_url. */
  justReturned?: boolean;
};

type Tone = "live" | "pending" | "blocked";

/**
 * One plain-language status instead of a row of flags. Stripe exposes four
 * booleans; a manager only needs to know whether money is moving and, if not,
 * whose turn it is to act.
 */
function accountStatus(b: BusinessPaymentsFields): {
  tone: Tone;
  label: string;
  detail: string;
} {
  const due = b.stripe_requirements_due;
  const dueText = `${due} ${due === 1 ? "detail" : "details"}`;

  if (!b.stripe_details_submitted) {
    return {
      tone: "pending",
      label: "Setup not finished",
      detail: "The business still has to complete its details on Stripe.",
    };
  }
  if (!b.stripe_charges_enabled) {
    return {
      tone: "blocked",
      label: "Not taking payments yet",
      detail:
        due > 0
          ? `Stripe needs ${dueText} before payments can start.`
          : "Stripe is reviewing what the business submitted.",
    };
  }
  if (!b.stripe_payouts_enabled) {
    return {
      tone: "pending",
      label: "Taking payments, payouts on hold",
      detail: "Stripe needs more information before it can pay this business.",
    };
  }
  if (due > 0) {
    return {
      tone: "pending",
      label: "Live, attention needed",
      detail: `Stripe needs ${dueText} soon to keep this account open.`,
    };
  }
  return {
    tone: "live",
    label: "Live",
    detail: "Taking payments and paying out.",
  };
}

const DOT: Record<Tone, string> = {
  live: "bg-emerald-500",
  pending: "bg-amber-500",
  blocked: "bg-red-500",
};

export function StripeConnectPanel({
  business,
  pending,
  paymentsConfigured,
  feeBps,
  justReturned = false,
}: StripeConnectPanelProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const connected = Boolean(business.stripe_account_id);
  const status = accountStatus(business);
  const needsAttention =
    connected &&
    (!business.stripe_charges_enabled || business.stripe_requirements_due > 0);
  const busy = isPending || !paymentsConfigured;

  // `account` is the one fees.payer value where Stripe bills the business and Prime
  // pays no Connect fee. Anything else, NULL included, is an account created before
  // this change: every one of those bills Prime, so they all get the same offer to
  // move. NULL happens whenever Stripe has not been read for the account yet, which
  // includes accounts the current API key cannot reach at all.
  const feeFree = business.stripe_fees_payer === "account";
  const legacyAccounts = business.stripe_account_id_legacy ?? [];

  function run(action: () => Promise<PaymentsActionResult>) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const res = await action();
      if (res.error) {
        setError(res.error);
        return;
      }
      if (res.url) {
        window.location.href = res.url;
        return;
      }
      if (res.ok) {
        setNotice("Saved.");
        router.refresh();
      }
    });
  }

  function confirmSwitch() {
    const ok = window.confirm(
      "Switch this business to the new account? Every new payment will settle there from now on. Payments already taken on the old account stay there, and refunds for them keep working.",
    );
    if (ok) run(() => switchToPendingAccount(business.id));
  }

  function confirmSwitchBack(accountId: string) {
    const ok = window.confirm(
      `Send payments back to ${accountId}? New payments will settle on that account again.`,
    );
    if (ok) run(() => switchToLegacyAccount(business.id, accountId));
  }

  // On return from Stripe onboarding, pull the latest status once.
  useEffect(() => {
    if (justReturned && paymentsConfigured && connected) {
      run(() => refreshAccountStatus(business.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-5">
      {!paymentsConfigured && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Payments are not configured yet. Set STRIPE_SECRET_KEY (and the webhook
          secrets) to enable Stripe onboarding and charges.
        </p>
      )}

      {connected ? (
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span
              className={cn("mt-1.5 size-2 shrink-0 rounded-full", DOT[status.tone])}
              aria-hidden
            />
            <div className="space-y-0.5">
              <p className="text-sm font-medium">{status.label}</p>
              <p className="text-xs text-muted-foreground">{status.detail}</p>
              <p className="pt-1 font-mono text-[0.7rem] text-muted-foreground/70">
                {business.stripe_account_id}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {needsAttention && (
              <Button
                type="button"
                disabled={busy}
                onClick={() => run(() => createOnboardingLink(business.id))}
              >
                Finish setup on Stripe
                <ExternalLink />
              </Button>
            )}
            {business.stripe_details_submitted && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => run(() => createLoginLink(business.id))}
              >
                Open Stripe dashboard
                <ExternalLink />
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => run(() => refreshAccountStatus(business.id))}
            >
              <RefreshCw />
              Refresh
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-8 text-center">
          <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <CreditCard className="size-5" />
          </span>
          <div className="space-y-1">
            <p className="text-sm font-medium">Accept payments with Stripe</p>
            <p className="mx-auto max-w-sm text-xs text-muted-foreground">
              Stripe collects the business details, verifies them, and pays out to
              their bank. It takes a few minutes and all of it happens on Stripe.
            </p>
          </div>
          <Button
            type="button"
            size="lg"
            disabled={busy}
            onClick={() => run(() => createConnectAccount(business.id))}
          >
            Set up payments with Stripe
            <ExternalLink />
          </Button>
        </div>
      )}

      {error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </p>
      )}

      {connected && (
        <div className="space-y-3 rounded-lg border bg-muted/30 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Stripe pricing</span>
            {feeFree ? (
              <Badge tone="success">Prime pays no Stripe fees</Badge>
            ) : (
              <Badge tone="warning">Old account</Badge>
            )}
          </div>

          {feeFree ? (
            <p className="text-xs text-muted-foreground">
              Stripe bills this business directly. Prime pays nothing per payout or per
              month for it, and still collects the platform fee below.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              This account predates the new setup, so Stripe bills Prime for it: 0.25%
              of everything paid out plus $2 in any month it pays out. A new account
              removes both charges and looks the same to the business (same Stripe
              dashboard, same onboarding). The business confirms its details once, then
              you switch it over here. Nothing changes for them until you do.
            </p>
          )}

          {pending ? (
            <div className="space-y-2 rounded-md border bg-background px-3 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">Replacement account</span>
                <Badge tone={pending.chargesEnabled ? "success" : "neutral"}>
                  {pending.chargesEnabled ? "Ready to switch" : "Onboarding"}
                </Badge>
                {pending.requirementsDue > 0 && (
                  <Badge tone="danger">
                    {pending.requirementsDue} still needed
                  </Badge>
                )}
              </div>
              <p className="font-mono text-[0.7rem] text-muted-foreground/70">
                {pending.id}
              </p>
              <p className="text-xs text-muted-foreground">
                It takes no payments until you switch over. Nothing changes for the
                business in the meantime.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || !pending.chargesEnabled}
                  onClick={confirmSwitch}
                >
                  Switch over
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => run(() => createOnboardingLink(business.id, "pending"))}
                >
                  Continue onboarding
                  <ExternalLink />
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => run(() => cancelFeeFreeMigration(business.id))}
                >
                  Discard
                </Button>
              </div>
            </div>
          ) : (
            !feeFree && (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => run(() => startFeeFreeMigration(business.id))}
              >
                Create the new account
                <ExternalLink />
              </Button>
            )
          )}

          {legacyAccounts.length > 0 && (
            <div className="space-y-2 border-t pt-3">
              <p className="text-xs text-muted-foreground">
                Replaced {legacyAccounts.length === 1 ? "account" : "accounts"}. Leave
                {legacyAccounts.length === 1 ? " it" : " them"} open on Stripe until the
                remaining balance pays out.
              </p>
              {legacyAccounts.map((id) => (
                <div key={id} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[0.7rem] text-muted-foreground/70">
                    {id}
                  </span>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => confirmSwitchBack(id)}
                  >
                    <RotateCcw />
                    Send payments back here
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <p className="border-t pt-4 text-sm text-muted-foreground">
        Platform fee: {(feeBps / 100).toFixed(2)}% (global, applied to every charge as
        Prime&apos;s application fee).
      </p>
    </div>
  );
}
