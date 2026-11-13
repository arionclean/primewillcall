"use client";

import type { StripeConnectInstance } from "@stripe/connect-js";
import { ConnectAccountManagement, ConnectComponentsProvider } from "@stripe/react-connect-js";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Dialog } from "@/components/ui/dialog";
import { invokeEdgeFunction } from "@/lib/payments/edge";

type AccountSession = { client_secret: string; publishable_key: string };

const UNREACHABLE = "Stripe could not be reached. Try again in a moment.";

/**
 * Stripe's own account form (the embedded "account management" component) for one
 * of the business's Stripe accounts. For an account with no Stripe login it is the
 * only way to change the payout bank: Stripe refuses update links for these, and an
 * onboarding link only asks for what is missing. Stripe signs the account's contact
 * in with a code before it shows the bank; that step is Stripe's, not ours.
 *
 * Each session comes from `stripe-connect` (`account_session`, owner only), which
 * records it in the activity log. Stripe's script loads only when this opens.
 */
export function StripeBankForm({
  businessId,
  accountId,
  onClose,
}: {
  businessId: string;
  accountId: string;
  onClose: () => void;
}) {
  const [instance, setInstance] = useState<StripeConnectInstance | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const newSession = () =>
      invokeEdgeFunction<AccountSession>("stripe-connect", {
        business_id: businessId,
        action: "account_session",
        account_id: accountId,
      });

    void (async () => {
      const first = await newSession();
      if (!alive) return;
      if (!first.data) {
        setError(first.error ?? UNREACHABLE);
        return;
      }
      // The first secret is spent on load; Stripe asks for a new one when it expires.
      let unused: string | null = first.data.client_secret;
      const { loadConnectAndInitialize } = await import("@stripe/connect-js/pure");
      if (!alive) return;
      setInstance(
        loadConnectAndInitialize({
          publishableKey: first.data.publishable_key,
          fetchClientSecret: async () => {
            if (unused) {
              const secret = unused;
              unused = null;
              return secret;
            }
            const next = await newSession();
            if (!next.data) throw new Error(next.error ?? UNREACHABLE);
            return next.data.client_secret;
          },
          appearance: {
            overlays: "dialog",
            variables: { colorPrimary: "#171717", borderRadius: "8px" },
          },
        }),
      );
    })();

    return () => {
      alive = false;
    };
  }, [businessId, accountId]);

  return (
    <Dialog title="Update bank" onClose={onClose} size="lg">
      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      ) : instance ? (
        <ConnectComponentsProvider connectInstance={instance}>
          <ConnectAccountManagement
            onLoadError={({ error: e }) => {
              console.error("[stripe-bank-form] Stripe's form did not load:", e);
              setError("Stripe's form could not load. Try again in a moment.");
            }}
          />
        </ConnectComponentsProvider>
      ) : (
        <div className="flex justify-center py-12">
          <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
        </div>
      )}
    </Dialog>
  );
}
