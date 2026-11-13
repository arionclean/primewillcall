"use client";

import { Popover } from "@base-ui/react/popover";
import { Info } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A small (i) that shows a line of help on hover, or on a tap on a phone (a popover,
 * not a tooltip, for that reason: tooltips never open on touch). For the explanation
 * a screen should offer but not print under every field. Warnings about something
 * that cannot be undone stay on the page; this is for everything else.
 */
export function InfoTip({
  text,
  label = "More information",
  className,
}: {
  text: string;
  /** What a screen reader announces for the (i). */
  label?: string;
  className?: string;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger
        type="button"
        openOnHover
        delay={100}
        aria-label={label}
        className={cn(
          "inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
          className,
        )}
      >
        <Info className="size-3.5" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" sideOffset={6} className="z-50">
          <Popover.Popup className="max-w-64 rounded-lg bg-foreground px-2.5 py-1.5 text-xs leading-snug text-background shadow-md outline-none">
            {text}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
