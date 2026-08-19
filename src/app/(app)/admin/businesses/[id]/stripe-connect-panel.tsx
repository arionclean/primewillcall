"use client";

import { CreditCard, ExternalLink, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";

/** One call into the `stripe-connect` edge function. */
type ConnectRequest = {
  action:
    | "status"
    | "create"
    | "onboarding_link"
    | "login_link"
    | "refresh"
    | "start_migration"
    | "switch_over"
    | "switch_back"
    | "cancel_migration";
  target?: "primary" | "pending";
  account_id?: string;
};

type ConnectResponse = {
  url?: string;
  ok?: true;
  configured?: boolean;
};

/**
 * Call the `stripe-connect` edge function.
 *
 * Stripe's platform key lives in Supabase, not on Vercel, so every Stripe call
 * happens there. `invoke` attaches the signed-in staff member's token, which the
 * function turns back into their staff row and re-checks the role against.
 *
 * On a non-2xx the SDK hands back an error whose `context` is the raw Response,
 * so read the body from there to recover the function's own message.
 */
async function invokeConnect(
  businessId: string,
  request: ConnectRequest,
): Promise<{ data: ConnectResponse | null; error: string | null }> {
  const { data, error } = await getSupabaseBrowserClient().functions.invoke<ConnectResponse>(
    "stripe-connect",
    { body: { business_id: businessId, ...request } },
  );
  if (!error) return { data: data ?? null, error: null };

  const response = (error as { context?: Response }).context;
  const payload = (await response?.json?.().catch(() => null)) as { error?: string } | null;
  return { data: null, error: payload?.error ?? error.message };
}

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
  justReturned = false,
}: StripeConnectPanelProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // null while the first status call is in flight, so the panel does not flash
  // "not switched on" at someone whose platform is configured fine.
  const [configured, setConfigured] = useState<boolean | null>(null);

  const connected = Boolean(business.stripe_account_id);
  const status = accountStatus(business);
  const needsAttention =
    connected &&
    (!business.stripe_charges_enabled || business.stripe_requirements_due > 0);
  const busy = isPending || configured === false;

  // True once the business is on the new account setup. Anything else, NULL
  // included, is an account created before it, and gets offered the move. NULL just
  // means Stripe has not been read for the account yet.
  const onNewSetup = business.stripe_fees_payer === "account";

  /**
   * Read Stripe's view of this business: is the platform usable, and is a switch
   * pending.
   *
   * A failed call is NOT treated as "no Stripe key". Not being able to reach the
   * function and the platform not having a key are different problems with
   * different fixes, and showing the second when it is really the first sends
   * whoever is looking at the wrong one.
   */
  const loadStatus = useCallback(async () => {
    const { data, error: err } = await invokeConnect(business.id, { action: "status" });
    if (err || !data) {
      setConfigured(null);
      setError(err ?? "Could not reach payments. Try again in a moment.");
      return;
    }
    setConfigured(data.configured ?? false);
  }, [business.id]);

  function run(request: ConnectRequest) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const { data, error: err } = await invokeConnect(business.id, request);
      if (err) {
        setError(err);
        return;
      }
      if (data?.url) {
        window.location.href = data.url;
        return;
      }
      if (data?.ok) {
        setNotice("Saved.");
        await loadStatus();
        router.refresh();
      }
    });
  }

  // Bootstrap: ask the function what it can do and whether a switch is pending.
  // Coming back from Stripe onboarding also re-syncs the row, since the details
  // the business just submitted are not in our copy yet.
  useEffect(() => {
    if (justReturned && connected) {
      run({ action: "refresh" });
      return;
    }
    void loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-5">
      {configured === false && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Card payments are not switched on for the platform yet, so this business
          cannot be set up right now.
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
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {needsAttention && (
              <Button
                type="button"
                disabled={busy}
                onClick={() => run({ action: "onboarding_link" })}
              >
                Finish setup on Stripe
                <ExternalLink />
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => run({ action: "refresh" })}
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
            onClick={() => run({ action: "create" })}
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

      {connected && !onNewSetup && (
        <div className="rounded-lg border bg-muted/30 px-4 py-3">
          {/* One button for the whole move. It creates the new account, or reopens
              the setup Stripe left half-finished, and the switch happens by itself
              once Stripe enables charges (see account.updated in stripe-webhook).
              Nothing here for anyone to decide or remember to come back and press. */}
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => run({ action: "start_migration" })}
          >
            Set up a new account
            <ExternalLink />
          </Button>
        </div>
      )}

    </div>
  );
}
