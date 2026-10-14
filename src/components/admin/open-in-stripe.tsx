"use client";

import { ExternalLink, Loader2 } from "lucide-react";
import { useState } from "react";

import { invokeEdgeFunction } from "@/lib/payments/edge";
import { stripeAccountUrl } from "@/lib/payments/stripe-reports";
import { cn } from "@/lib/utils";

/**
 * "Open in Stripe": opens the business's own Stripe dashboard in a new tab, through a
 * one-time login link from `stripe-connect`, so no Stripe sign-in is needed. It opens
 * `accountId`, which may be an account the business was moved away from (a dispute on
 * a sale taken before the move lives there). An account Stripe makes no such link for
 * (one that is not an Express account) opens on its page in Prime's dashboard instead.
 */
export function OpenInStripe({
  businessId,
  accountId,
  className,
}: {
  /** Null when the account's business is unknown: Prime's dashboard page is all there is. */
  businessId: string | null;
  accountId: string;
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
      const { data } = await invokeEdgeFunction<{ url?: string }>("stripe-connect", {
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
      Open in Stripe
      {opening ? (
        <Loader2 className="size-3 animate-spin" aria-hidden />
      ) : (
        <ExternalLink className="size-3" aria-hidden />
      )}
    </button>
  );
}
