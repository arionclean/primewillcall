"use client";

import { useState } from "react";
import { Link2 } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * "Payment link" action for the booking edit modal: asks the server to mint a
 * Stripe Checkout link for this booking, copies it to the clipboard, and shows
 * it in a small popover with Copy / Open. Self-contained so it drops into the
 * modal footer without touching the large list component's state. Only rendered
 * for owner / business_manager on a chargeable, non-cancelled booking.
 */
export function PaymentLinkButton({
  bookingId,
  amountCents,
  status,
  disabled,
}: {
  bookingId: string;
  amountCents: number;
  status: string;
  disabled?: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (amountCents <= 0 || status === "cancelled") return null;

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be blocked; the link is still shown to copy manually.
    }
  }

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/payment-link`, {
        method: "POST",
      });
      const body = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !body.url) {
        setError(body.error ?? "Could not create a link.");
        return;
      }
      setUrl(body.url);
      void copy(body.url);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative">
      <Button
        type="button"
        variant="outline"
        disabled={disabled || loading}
        onClick={() => void generate()}
      >
        <Link2 aria-hidden className="size-4" />
        {loading ? "Creating…" : "Payment link"}
      </Button>

      {(url || error) && (
        <div className="absolute bottom-full left-0 z-10 mb-2 w-[20rem] rounded-md border bg-popover p-3 text-sm shadow-md">
          {error ? (
            <p className="text-destructive">{error}</p>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {copied ? "Copied to clipboard. " : ""}Send this link to the
                customer to collect payment:
              </p>
              <input
                readOnly
                value={url ?? ""}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full truncate rounded border bg-background px-2 py-1 font-mono text-xs"
              />
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => url && void copy(url)}
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
                <a
                  href={url ?? "#"}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-primary underline-offset-4 hover:underline"
                >
                  Open
                </a>
                <button
                  type="button"
                  onClick={() => {
                    setUrl(null);
                    setError(null);
                  }}
                  className="ml-auto text-xs text-muted-foreground hover:text-foreground"
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
