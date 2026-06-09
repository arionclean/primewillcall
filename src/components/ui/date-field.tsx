"use client";

import { forwardRef } from "react";

import { cn } from "@/lib/utils";

/**
 * A date input that opens the native calendar on click instead of letting the
 * user type into the MM/DD/YYYY segments. Typing is blocked (it is easy to fat
 * finger a wrong year), so the calendar is the only way to pick a date. Keyboard
 * users can still Tab to it and press Enter, Space, or ArrowDown to open it.
 *
 * Pass the same props you would pass to a native `<input type="date">`
 * (value, onChange, className, disabled, required, aria-label, ...).
 */
export type DateFieldProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type"
>;

function openPicker(el: HTMLInputElement) {
  try {
    el.showPicker?.();
  } catch {
    // showPicker throws if unsupported or called without a user gesture.
    // The field still works as a normal date input in that case.
  }
}

export const DateField = forwardRef<HTMLInputElement, DateFieldProps>(
  function DateField({ onKeyDown, onMouseDown, className, ...props }, ref) {
    return (
      <input
        ref={ref}
        type="date"
        className={cn(
          "h-10 w-full rounded-md border bg-background px-3 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        onMouseDown={(e) => {
          // Open the calendar rather than dropping a cursor into a segment.
          e.preventDefault();
          const el = e.currentTarget;
          el.focus();
          openPicker(el);
          onMouseDown?.(e);
        }}
        onKeyDown={(e) => {
          if (e.key === "Tab") {
            onKeyDown?.(e);
            return;
          }
          // Block typing; let a few keys open the calendar.
          e.preventDefault();
          if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
            openPicker(e.currentTarget);
          }
          onKeyDown?.(e);
        }}
        {...props}
      />
    );
  },
);
