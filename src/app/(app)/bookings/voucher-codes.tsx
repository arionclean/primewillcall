"use client";

/**
 * Groupon Redemption Codes on a bookings row.
 *
 * Staff redeem a voucher on Groupon by its Redemption Code, so a /gp booking carries
 * its codes in `bookings.groupon_voucher_codes` and the list shows them under the
 * guest's name with a one-click copy. The "Copied" callout is shared with the row's
 * other copy buttons (`components/ui/copy-button`).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Ticket } from "lucide-react";

import { CopiedBubble } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";

/** "21863636" -> "•••• 8636". A code redeems the voucher, so privacy mode hides it. */
function maskCode(code: string): string {
  return `•••• ${code.slice(-4)}`;
}

const codeChipClass =
  "relative inline-flex h-6 max-w-full items-center gap-1 rounded-md border border-input bg-background px-1.5 font-mono text-[11px] tabular-nums text-muted-foreground transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

type CodeListLayout = {
  left: number;
  placement: "top" | "bottom";
  top: number;
  width: number;
};

/**
 * The Groupon Redemption Codes of a /gp booking, under the guest's name, so staff
 * never retype one into Groupon. One code is a chip that copies on click. Several
 * show the first plus a count and open a small list where each code copies on its
 * own (Groupon's redeem screen takes one code at a time) and keeps a check once
 * copied, so the owner can see which vouchers are already done. Owner-only (the
 * row decides, like the Redeem toggle) and read-only: the Redeem toggle in the
 * actions column is unchanged.
 */
export function VoucherCodes({
  bookingId,
  codes,
  privacyOn,
  copiedKey,
  onCopyField,
}: {
  bookingId: string;
  codes: string[];
  privacyOn: boolean;
  copiedKey: string | null;
  onCopyField: (key: string, value: string, errorMessage: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [layout, setLayout] = useState<CodeListLayout | null>(null);
  // Positions copied while the list is open (a guest can upload one voucher twice,
  // so the code itself is not a safe key).
  const [done, setDone] = useState<number[]>([]);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const keyFor = (index: number) => `${bookingId}:code:${index}`;
  const copyOne = (index: number) => {
    onCopyField(keyFor(index), codes[index], "Unable to copy the voucher code.");
    setDone((current) =>
      current.includes(index) ? current : [...current, index],
    );
  };
  const copyAll = () => {
    onCopyField(
      `${bookingId}:codes`,
      codes.join("\n"),
      "Unable to copy the voucher codes.",
    );
    setDone(codes.map((_, index) => index));
  };

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportPadding = 12;
    const width = Math.min(260, window.innerWidth - viewportPadding * 2);
    const left = Math.min(
      Math.max(rect.left, viewportPadding),
      window.innerWidth - width - viewportPadding,
    );
    const spaceBelow = window.innerHeight - rect.bottom;
    const placement =
      spaceBelow < 260 && rect.top > spaceBelow ? "top" : "bottom";
    setLayout({
      left,
      placement,
      top: placement === "top" ? rect.top - 8 : rect.bottom + 8,
      width,
    });
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setLayout(null);
    setDone([]);
  }, []);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !panelRef.current?.contains(target)
      ) {
        close();
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, close, place]);

  if (codes.length === 0) return null;
  const first = codes[0];
  const extra = codes.length - 1;

  if (privacyOn) {
    return (
      <span
        className={cn(codeChipClass, "cursor-default")}
        title="Groupon code (hidden while privacy is on)"
      >
        <Ticket className="size-3 shrink-0" />
        <span className="truncate">{maskCode(first)}</span>
        {extra > 0 ? <span className="text-foreground/60">+{extra}</span> : null}
      </span>
    );
  }

  if (extra === 0) {
    const copied = copiedKey === keyFor(0);
    return (
      <button
        type="button"
        onClick={() => copyOne(0)}
        title="Copy Groupon code"
        className={cn(codeChipClass, "hover:bg-muted hover:text-foreground")}
      >
        <Ticket className="size-3 shrink-0" />
        <span className="truncate">{first}</span>
        {copied ? (
          <>
            <Check className="size-3 shrink-0 animate-in zoom-in-75 text-emerald-600" />
            <CopiedBubble />
          </>
        ) : (
          <Copy className="size-3 shrink-0" />
        )}
      </button>
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (open) {
            close();
          } else {
            place();
            setOpen(true);
          }
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`${codes.length} Groupon codes`}
        className={cn(
          codeChipClass,
          "hover:bg-muted hover:text-foreground",
          open ? "bg-muted text-foreground" : "",
        )}
      >
        <Ticket className="size-3 shrink-0" />
        <span className="truncate">{first}</span>
        <span className="rounded bg-muted px-1 text-[10px] font-semibold text-foreground/70">
          +{extra}
        </span>
      </button>
      {open && layout && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              role="dialog"
              aria-label="Groupon codes"
              className={cn(
                "fixed z-[90]",
                layout.placement === "top" ? "-translate-y-full" : "",
              )}
              style={{ left: layout.left, top: layout.top, width: layout.width }}
            >
              <div className="rounded-xl border bg-card p-1.5 shadow-2xl animate-in fade-in zoom-in-95 duration-150">
                <p className="px-2 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">
                  {codes.length} Groupon codes. Click one to copy it.
                </p>
                <ul className="space-y-0.5">
                  {codes.map((code, index) => {
                    const isDone = done.includes(index);
                    const justCopied = copiedKey === keyFor(index);
                    return (
                      <li key={`${code}-${index}`}>
                        <button
                          type="button"
                          onClick={() => copyOne(index)}
                          className="relative flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left font-mono text-xs tabular-nums transition hover:bg-muted"
                        >
                          <span className="truncate">{code}</span>
                          {isDone ? (
                            <Check className="size-3.5 shrink-0 text-emerald-600" />
                          ) : (
                            <Copy className="size-3.5 shrink-0 text-muted-foreground" />
                          )}
                          {justCopied ? <CopiedBubble /> : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <div className="mt-1 border-t pt-1">
                  <button
                    type="button"
                    onClick={copyAll}
                    className="relative flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-xs font-medium text-indigo-600 transition hover:bg-indigo-50"
                  >
                    <span>Copy all</span>
                    {copiedKey === `${bookingId}:codes` ? (
                      <>
                        <Check className="size-3.5 shrink-0 text-emerald-600" />
                        <CopiedBubble />
                      </>
                    ) : null}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
