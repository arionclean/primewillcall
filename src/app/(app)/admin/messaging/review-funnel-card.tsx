"use client";

import { useState, useTransition } from "react";
import { ChevronDown, Lock } from "lucide-react";

import { REVIEW_STEPS } from "@/lib/reviews/copy";
import { cn } from "@/lib/utils";

import { setReviewAutomationEnabledAction } from "./review-actions";

/**
 * The post-tour review funnel, shown read-only.
 *
 * Unlike the automations above it, this is a fixed flow: it branches on what
 * the customer replies and cancels itself when a booking is un-checked-in,
 * which the rules model cannot express. Staff will never author another one,
 * so the wording lives in code and the only control here is on/off.
 */
export function ReviewFunnelCard({
  enabled,
  businessesWithLink,
}: {
  enabled: boolean;
  businessesWithLink: number;
}) {
  const [on, setOn] = useState(enabled);
  // Collapsed by default: the flow is fixed and read-only, so it is reference
  // material rather than something staff need open while working.
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next = !on;
    setOn(next);
    setError(null);
    startTransition(async () => {
      const result = await setReviewAutomationEnabledAction(next);
      if (result.error) {
        setOn(!next); // roll back
        setError(result.error);
      }
    });
  }

  return (
    <section className="mt-10">
      <div className="mb-3 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="-mx-2 flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-1 text-left transition-colors hover:bg-muted/50"
        >
          <span className="min-w-0 flex-1">
            {/* span, not h2: a button may only contain phrasing content. */}
            <span
              role="heading"
              aria-level={2}
              className="flex items-center gap-2 text-sm font-semibold"
            >
              Review funnel
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                <Lock className="size-3" aria-hidden />
                Fixed flow
              </span>
            </span>
            <span className="mt-1 block text-sm text-muted-foreground">
              Asks guests to rate the tour.
            </span>
          </span>
          <ChevronDown
            size={16}
            className="shrink-0 text-muted-foreground"
            style={{
              transform: open ? "rotate(180deg)" : "none",
              transition: "transform 150ms ease",
            }}
            aria-hidden
          />
        </button>

        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Review funnel on"
          onClick={toggle}
          disabled={pending}
          className={cn(
            "relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50",
            on ? "bg-indigo-600" : "bg-muted-foreground/30",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 size-5 rounded-full bg-white shadow transition-all",
              on ? "left-[22px]" : "left-0.5",
            )}
          />
        </button>
      </div>

      {error ? (
        <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {on && businessesWithLink === 0 ? (
        <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          On, but no business has a Google review link set yet, so nothing will
          send. Add one on each business page.
        </p>
      ) : null}

      {open ? (
        <ol className="space-y-2">
          {REVIEW_STEPS.map((step, i) => (
            <li key={step.key} className="rounded-lg border bg-card p-3">
              <div className="flex items-baseline gap-2">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
                  {i + 1}
                </span>
                <span className="text-sm font-medium">{step.when}</span>
              </div>
              <p className="mt-2 ml-7 rounded-md bg-muted/50 px-3 py-2 text-sm text-foreground/90">
                {step.preview}
              </p>
              <p className="mt-1.5 ml-7 text-xs text-muted-foreground">
                {step.detail}
              </p>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
