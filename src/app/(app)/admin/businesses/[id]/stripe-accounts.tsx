"use client";

import { AlertTriangle, ExternalLink, Loader2, Plus } from "lucide-react";
import { useEffect, useState } from "react";

import { OpenInStripe } from "@/components/admin/open-in-stripe";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { invokeEdgeFunction } from "@/lib/payments/edge";
import { cn } from "@/lib/utils";

import { StripeBankForm } from "./stripe-bank-form";

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
  /** How many details Stripe is asking for right now. */
  requirementsDue: number;
  /**
   * The bank it pays out to. `rejected`: the bank turned down a transfer, and Stripe
   * sends nothing more there until the business enters the bank again.
   */
  bank: { last4: string; rejected: boolean } | null;
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

const CARD_LABEL = "text-[11px] font-medium tracking-wider text-muted-foreground uppercase";

/**
 * Every Stripe account this business has (the one in use, one waiting for a switch,
 * the ones it used before), one card each, plus Add Stripe account while the business
 * has no Standard account (its own Stripe login) in use or waiting. Read live from
 * Stripe through `stripe-connect`, so which screen an account has, and whether Stripe
 * has finished setting it up, is Stripe's answer, never ours.
 *
 * Back from Stripe's sign-up form (`justReturned`), it also copies the active
 * account's state into our row, since what the business just submitted is not there yet.
 */
export function StripeAccounts({
  businessId,
  justReturned = false,
}: {
  businessId: string;
  justReturned?: boolean;
}) {
  const [accounts, setAccounts] = useState<StripeAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped when Stripe's account form closes, so a fixed bank shows as fixed.
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (justReturned) {
      void invokeEdgeFunction("stripe-connect", { business_id: businessId, action: "refresh" });
    }
  }, [businessId, justReturned]);

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
  }, [businessId, reload]);

  if (error) {
    return (
      <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        {error}
      </p>
    );
  }

  if (!accounts) {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        {[0, 1].map((i) => (
          <Card key={i} className="space-y-4 p-5" aria-busy>
            <div className="h-3 w-24 animate-pulse rounded bg-muted" />
            <div className="h-5 w-28 animate-pulse rounded bg-muted" />
            <div className="h-3 w-full animate-pulse rounded bg-muted" />
            <div className="h-3 w-full animate-pulse rounded bg-muted" />
          </Card>
        ))}
      </div>
    );
  }

  const active = accounts.find((a) => a.role === "current");
  const waiting = accounts.find((a) => a.role === "waiting");
  // A Standard account in use or on its way leaves nothing to add.
  const canAdd = active?.dashboard !== "full" && waiting?.dashboard !== "full";

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {accounts.map((a) => (
        <AccountCard
          key={a.id}
          account={a}
          businessId={businessId}
          onChanged={() => setReload((n) => n + 1)}
        />
      ))}
      {canAdd && (
        <AddAccountCard businessId={businessId} hasAccount={Boolean(active)} />
      )}
    </div>
  );
}

/**
 * What an account still needs from the business, in Stripe's terms, and where the
 * button sends them: the active account when Stripe asks for more to keep it taking
 * payments, a waiting one until the business has finished signing up.
 */
function pendingSetup(a: StripeAccount): { note: string; target: "primary" | "pending" | null } | null {
  if (a.error) return null;
  if (a.role === "current" && (!a.chargesEnabled || a.requirementsDue > 0)) {
    return { note: "Stripe needs more details to keep this account taking payments.", target: "primary" };
  }
  if (a.role === "waiting") {
    if (!a.detailsSubmitted) {
      return { note: "Stripe needs the business's details before this account can be used.", target: "pending" };
    }
    if (!a.chargesEnabled) return { note: "Stripe is reviewing the details for this account.", target: null };
  }
  return null;
}

function AccountCard({
  account: a,
  businessId,
  onChanged,
}: {
  account: StripeAccount;
  businessId: string;
  onChanged: () => void;
}) {
  const status = STATUS[a.role];
  const dashboard = a.dashboard ? DASHBOARD[a.dashboard] : null;
  const setup = pendingSetup(a);
  const bankRejected = Boolean(a.bank?.rejected);
  const [bankFormOpen, setBankFormOpen] = useState(false);

  return (
    <Card className="flex flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className={CARD_LABEL}>Stripe account</p>
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
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Bank</dt>
          <dd className={cn(bankRejected && "text-amber-700 dark:text-amber-300")}>
            {a.bank ? `•••• ${a.bank.last4}` : "Unknown"}
          </dd>
        </div>
      </dl>

      <div className="mt-auto space-y-3 pt-5">
        {bankRejected && (
          <p className="flex gap-1.5 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
            The bank turned down a transfer from Stripe. Payouts are on hold until the bank is
            entered again.
          </p>
        )}
        {setup && <p className="text-xs text-muted-foreground">{setup.note}</p>}
        {setup?.target ? (
          <StripeFormButton
            businessId={businessId}
            request={{ action: "onboarding_link", target: setup.target }}
            label="Finish setup with Stripe"
          />
        ) : bankRejected && a.dashboard === "none" ? (
          // No Stripe login to fix it from: Stripe's own form, inside the app.
          <Button type="button" size="sm" className="w-full" onClick={() => setBankFormOpen(true)}>
            Update bank
          </Button>
        ) : dashboard?.action ? (
          <OpenInStripe
            businessId={businessId}
            accountId={a.id}
            label={dashboard.action}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-full")}
          />
        ) : (
          a.error && (
            <p className="text-xs text-muted-foreground">Stripe could not be reached for this account.</p>
          )
        )}
      </div>

      {bankFormOpen && (
        <StripeBankForm
          businessId={businessId}
          accountId={a.id}
          onClose={() => {
            setBankFormOpen(false);
            onChanged();
          }}
        />
      )}
    </Card>
  );
}

/**
 * Opens a new Standard account (the business's own Stripe login, Stripe's fees billed
 * to the business) and hands off to Stripe's sign-up form. With an account in use it
 * waits beside it until the business is switched over; with none it is the first.
 * A second click confirms, since this opens a real account in Stripe.
 */
function AddAccountCard({
  businessId,
  hasAccount,
}: {
  businessId: string;
  hasAccount: boolean;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <Card className="flex flex-col border-dashed p-5 shadow-none">
      <p className={CARD_LABEL}>New Stripe account</p>
      <p className="mt-1 text-base font-medium">Standard</p>

      <div className="mt-auto space-y-3 pt-5">
        {confirming ? (
          <>
            <p className="text-xs">
              Stripe asks for the business&apos;s details next.
              {hasAccount && " The active account keeps taking payments until the new one is ready."}
            </p>
            <div className="flex gap-2">
              <StripeFormButton
                businessId={businessId}
                request={{ action: hasAccount ? "start_migration" : "create" }}
                label="Continue to Stripe"
                className="flex-1"
              />
              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <Button type="button" size="sm" variant="outline" className="w-full" onClick={() => setConfirming(true)}>
            <Plus aria-hidden />
            Add Stripe account
          </Button>
        )}
      </div>
    </Card>
  );
}

/**
 * Asks `stripe-connect` for one of Stripe's sign-up forms and goes there. The form is
 * the only way in: Stripe's links may not be emailed or texted, so it is a button here.
 */
function StripeFormButton({
  businessId,
  request,
  label,
  className,
}: {
  businessId: string;
  request: { action: "onboarding_link" | "start_migration" | "create"; target?: "primary" | "pending" };
  label: string;
  className?: string;
}) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setOpening(true);
    setError(null);
    const { data, error: err } = await invokeEdgeFunction<{ url?: string }>("stripe-connect", {
      business_id: businessId,
      ...request,
    });
    if (data?.url) {
      window.location.href = data.url;
      return;
    }
    setOpening(false);
    setError(err ?? "Stripe could not be reached. Try again in a moment.");
  }

  return (
    <div className={cn("space-y-2", className ?? "w-full")}>
      <Button type="button" size="sm" className="w-full" disabled={opening} onClick={open}>
        {label}
        {opening ? <Loader2 className="animate-spin" aria-hidden /> : <ExternalLink aria-hidden />}
      </Button>
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}
