"use client";

import { ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { OpenInStripe } from "@/components/admin/open-in-stripe";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { invokeEdgeFunction } from "@/lib/payments/edge";
import { cn } from "@/lib/utils";

/** One of the business's Stripe accounts, as `stripe-connect` (action `accounts`) reads it. */
type StripeAccount = {
  id: string;
  role: "current" | "waiting" | "previous";
  /** Which Stripe screen its owner can sign in to. Null when Stripe could not be read. */
  dashboard: "full" | "express" | "none" | null;
  opened: string | null;
  /** Whether the owner has given Stripe everything it asked for at sign-up. */
  detailsSubmitted: boolean;
  /** Whether Stripe lets the account take payments. */
  chargesEnabled: boolean;
  error: string | null;
};

const STATUS: Record<StripeAccount["role"], { label: string; tone: "success" | "warning" | "neutral" }> = {
  current: { label: "Active", tone: "success" },
  waiting: { label: "Pending", tone: "warning" },
  previous: { label: "Previous", tone: "neutral" },
};

/** What Stripe gives the account's owner to sign in to, and the button that opens it. */
const DASHBOARD: Record<"full" | "express" | "none", { label: string; action: string | null }> = {
  full: { label: "Stripe Dashboard", action: "Sign in to Stripe" },
  express: { label: "Stripe Express", action: "Open Stripe Express" },
  none: { label: "Not available", action: null },
};

const DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  year: "numeric",
});

/**
 * Every Stripe account this business has (the one in use, one waiting for a switch,
 * the ones it used before), one card each, with a way into Stripe for each account
 * Stripe has a screen for. Read live from Stripe through `stripe-connect`, so which
 * screen an account has is Stripe's answer, never ours.
 */
export function StripeAccounts({ businessId }: { businessId: string }) {
  const [accounts, setAccounts] = useState<StripeAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void invokeEdgeFunction<{ accounts: StripeAccount[] }>("stripe-connect", {
      business_id: businessId,
      action: "accounts",
    }).then(({ data, error: err }) => {
      if (!current) return;
      if (err || !data) setError(err ?? "Stripe could not be reached. Try again in a moment.");
      else setAccounts(data.accounts);
    });
    return () => {
      current = false;
    };
  }, [businessId]);

  if (error) {
    return (
      <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        {error}
      </p>
    );
  }

  if (accounts?.length === 0) {
    return <p className="text-sm text-muted-foreground">This business has no Stripe account yet.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {accounts
          ? accounts.map((a) => <AccountCard key={a.id} account={a} businessId={businessId} />)
          : [0, 1].map((i) => (
              <Card key={i} className="space-y-4 p-5" aria-busy>
                <div className="h-3 w-24 animate-pulse rounded bg-muted" />
                <div className="h-5 w-28 animate-pulse rounded bg-muted" />
                <div className="h-3 w-full animate-pulse rounded bg-muted" />
                <div className="h-3 w-full animate-pulse rounded bg-muted" />
              </Card>
            ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Balances, payouts and bank details for these accounts are held and managed by Stripe.
      </p>
    </div>
  );
}

/**
 * What a waiting account still needs, in Stripe's terms: the owner's details first,
 * then Stripe's own review. Null once Stripe has verified it (or for any other role).
 */
function waitingNote(a: StripeAccount): string | null {
  if (a.role !== "waiting" || a.error) return null;
  if (!a.detailsSubmitted) return "Stripe needs a few details from the business before this account can be used.";
  if (!a.chargesEnabled) return "Stripe is reviewing the details for this account.";
  return null;
}

function AccountCard({ account: a, businessId }: { account: StripeAccount; businessId: string }) {
  const status = STATUS[a.role];
  const dashboard = a.dashboard ? DASHBOARD[a.dashboard] : null;
  const note = waitingNote(a);

  return (
    <Card className="flex flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
            Stripe account
          </p>
          <p className="mt-1 font-mono text-base tracking-wide">•••• {a.id.slice(-4)}</p>
        </div>
        <Badge tone={status.tone}>
          <span className="size-1.5 rounded-full bg-current" aria-hidden />
          {status.label}
        </Badge>
      </div>

      <dl className="mt-5 space-y-2 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Opened</dt>
          <dd>{a.opened ? DAY.format(new Date(a.opened)) : "Unknown"}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Dashboard</dt>
          <dd>{dashboard?.label ?? "Unknown"}</dd>
        </div>
      </dl>

      <div className="mt-auto space-y-3 pt-5">
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
        {a.role === "waiting" && !a.error && !a.detailsSubmitted ? (
          <FinishSetup businessId={businessId} />
        ) : dashboard?.action ? (
          <OpenInStripe
            businessId={businessId}
            accountId={a.id}
            label={dashboard.action}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-full")}
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            {a.error
              ? "Stripe could not be reached for this account."
              : "Stripe does not provide a dashboard for this account."}
          </p>
        )}
      </div>
    </Card>
  );
}

/**
 * Sends the owner to Stripe's own sign-up form for the waiting account, the only
 * way in: Stripe's links may not be emailed or texted, so it is a button here.
 */
function FinishSetup({ businessId }: { businessId: string }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setOpening(true);
    setError(null);
    const { data, error: err } = await invokeEdgeFunction<{ url?: string }>("stripe-connect", {
      business_id: businessId,
      action: "onboarding_link",
      target: "pending",
    });
    if (data?.url) {
      window.location.href = data.url;
      return;
    }
    setOpening(false);
    setError(err ?? "Stripe could not be reached. Try again in a moment.");
  }

  return (
    <div className="space-y-2">
      <Button type="button" size="sm" className="w-full" disabled={opening} onClick={open}>
        Finish setup with Stripe
        {opening ? <Loader2 className="animate-spin" aria-hidden /> : <ExternalLink aria-hidden />}
      </Button>
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}
