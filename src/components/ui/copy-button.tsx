"use client";

/**
 * The small icon button that copies one value, plus the "Copied" callout it shows.
 *
 * Staff copy the same handful of things off a bookings row all day (the guest's
 * name, their phone, the booking ID, a Groupon code), so the affordance is one
 * component instead of the same markup pasted per field. The parent owns the
 * copy itself and which key is currently copied, so a row can show the check on
 * exactly the button that was clicked.
 */

import { Check, Copy } from "lucide-react";

import { cn } from "@/lib/utils";

/** The "Copied" callout shown above a copy button for a moment after a copy. */
export function CopiedBubble() {
  return (
    <div className="pointer-events-none absolute bottom-full left-1/2 z-30 -translate-x-1/2 pb-3">
      <span className="relative block rounded-2xl bg-foreground px-3 py-1.5 text-[10px] font-semibold text-background shadow-2xl animate-in fade-in zoom-in-95 duration-200">
        Copied
        <span
          aria-hidden="true"
          className="absolute left-1/2 top-full size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-foreground"
        />
      </span>
    </div>
  );
}

/**
 * A copy icon that turns into a green check while `copied` is true.
 *
 * `label` is the screen-reader name ("Copy guest name"); `title` is the native
 * tooltip when the value itself is worth showing on hover.
 */
export function CopyIconButton({
  label,
  copied,
  onClick,
  title,
  className,
}: {
  label: string;
  copied: boolean;
  onClick: () => void;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "relative inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        className,
      )}
    >
      <span className="sr-only">{label}</span>
      {copied ? (
        <>
          <Check className="size-3.5 animate-in zoom-in-75 text-emerald-600" />
          <CopiedBubble />
        </>
      ) : (
        <Copy className="size-3.5" />
      )}
    </button>
  );
}
