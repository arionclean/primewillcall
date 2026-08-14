"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

import {
  createConnectAccount,
  createLoginLink,
  createOnboardingLink,
  linkExistingAccount,
  refreshAccountStatus,
  type PaymentsActionResult,
} from "./payments-actions";

type StripeConnectPanelProps = {
  business: {
    id: string;
    stripe_account_id: string | null;
    stripe_charges_enabled: boolean;
    stripe_payouts_enabled: boolean;
    stripe_details_submitted: boolean;
    stripe_requirements_due: number;
  };
  paymentsConfigured: boolean;
  /** True when the page loaded from a Stripe onboarding return_url. */
  justReturned?: boolean;
};

export function StripeConnectPanel({
  business,
  paymentsConfigured,
  justReturned = false,
}: StripeConnectPanelProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [acctId, setAcctId] = useState("");

  const connected = Boolean(business.stripe_account_id);
  const needsAttention =
    connected &&
    (!business.stripe_charges_enabled || business.stripe_requirements_due > 0);

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

  // On return from Stripe onboarding, pull the latest status once.
  useEffect(() => {
    if (justReturned && paymentsConfigured && connected) {
      run(() => refreshAccountStatus(business.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-4">
      {!paymentsConfigured && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Card payments are not switched on for the platform yet, so this
          business cannot be set up right now.
        </p>
      )}

      {connected ? (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={business.stripe_charges_enabled ? "success" : "neutral"}>
            {business.stripe_charges_enabled
              ? "Taking payments"
              : "Not taking payments yet"}
          </Badge>
          <Badge tone={business.stripe_payouts_enabled ? "success" : "neutral"}>
            {business.stripe_payouts_enabled ? "Payouts on" : "Payouts on hold"}
          </Badge>
          <Badge tone={business.stripe_details_submitted ? "success" : "warning"}>
            {business.stripe_details_submitted
              ? "Details complete"
              : "Details needed"}
          </Badge>
          {business.stripe_requirements_due > 0 && (
            <Badge tone="danger">
              {business.stripe_requirements_due} thing
              {business.stripe_requirements_due === 1 ? "" : "s"} left to finish
            </Badge>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          This business is not set up to take payments yet.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!connected && (
          <Button
            type="button"
            disabled={isPending || !paymentsConfigured}
            onClick={() => run(() => createConnectAccount(business.id))}
          >
            Set up payments
          </Button>
        )}
        {needsAttention && (
          <Button
            type="button"
            disabled={isPending || !paymentsConfigured}
            onClick={() => run(() => createOnboardingLink(business.id))}
          >
            Finish setup
          </Button>
        )}
        {connected && business.stripe_details_submitted && (
          <Button
            type="button"
            variant="outline"
            disabled={isPending || !paymentsConfigured}
            onClick={() => run(() => createLoginLink(business.id))}
          >
            Open Stripe dashboard
          </Button>
        )}
        {connected && (
          <Button
            type="button"
            variant="outline"
            disabled={isPending || !paymentsConfigured}
            onClick={() => run(() => refreshAccountStatus(business.id))}
          >
            Refresh status
          </Button>
        )}
      </div>

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

      <details className="rounded-md border bg-muted/30 px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium">
          Use an account this business already has
        </summary>
        <div className="mt-3 space-y-2">
          <Field
            label="Stripe account ID"
            htmlFor="stripe-acct"
            hint="If this business is already on Stripe, paste its account ID here instead of setting up a new one."
          >
            <Input
              id="stripe-acct"
              value={acctId}
              onChange={(e) => setAcctId(e.target.value)}
              placeholder="acct_..."
            />
          </Field>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isPending || !paymentsConfigured || acctId.trim() === ""}
            onClick={() => run(() => linkExistingAccount(business.id, acctId))}
          >
            Link account
          </Button>
        </div>
      </details>
    </div>
  );
}
