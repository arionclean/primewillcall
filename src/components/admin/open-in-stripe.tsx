"use client";

import { ExternalLink, Loader2 } from "lucide-react";
import { useState } from "react";

import { invokeEdgeFunction } from "@/lib/payments/edge";
import { stripeAccountUrl } from "@/lib/payments/stripe-reports";
import { cn } from "@/lib/utils";

/**
 * "Open in Stripe": opens the business's own Stripe dashboard in a new tab. An Express
 * account opens through a one-time login link from `stripe-connect`, so no Stripe
 * sign-in is needed; a full-dashboard account opens Stripe's sign-in, for the
 * business's own Stripe login. It opens `accountId`, which may be an account the
 * business was moved away from (a dispute on a sale taken before the move lives
 * there). An account with no Stripe login opens on its page in Prime's dashboard.
 */
export function OpenInStripe({
  businessId,
  accountId,
  label = "Open in Stripe",
  className,
}: {
  /** Null when the account's business is unknown: Prime's dashboard page is all there is. */
  businessId: string | null;
  accountId: string;
  label?: string;
  className?: string;
}) {
  const [opening, setOpening] = useState(false);

  async function open() {
    // The tab is opened inside the click: one opened after the call returns is blocked
    // as a pop-up, on the iPhone above all.
    const tab = window.open("", "_blank");
    let url = stripeAccountUrl(accountId);
    if (businessId) {
      setOpening(true);
      // No url (an account with no Stripe login) keeps Prime's dashboard page.
      const { data } = await invokeEdgeFunction<{ url?: string | null }>("stripe-connect", {
        business_id: businessId,
        action: "login_link",
        account_id: accountId,
      });
      setOpening(false);
      if (data?.url) url = data.url;
    }
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    } else {
      window.location.href = url;
    }
  }

  return (
    <button type="button" onClick={open} disabled={opening} className={cn("inline-flex items-center gap-1", className)}>
      {label}
      {opening ? (
        <Loader2 className="size-3 animate-spin" aria-hidden />
      ) : (
        <ExternalLink className="size-3" aria-hidden />
      )}
    </button>
  );
}
