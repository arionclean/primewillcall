"use client";

import { LoaderCircle } from "lucide-react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type SubmitButtonProps = Omit<
  React.ComponentProps<typeof Button>,
  "className" | "type"
> & {
  className?: string;
  /** Read out to screen readers while the form is submitting. */
  pendingLabel?: string;
};

/**
 * Submit button that disables itself and swaps its label for a spinner while
 * its own form is in flight, so a slow server action cannot be fired twice by
 * an impatient second click. Render it inside the form it submits: it reads
 * the pending state of the nearest parent form, so sibling forms on the same
 * card keep their own state.
 */
function SubmitButton({
  children,
  className,
  disabled,
  pendingLabel = "Working",
  ...props
}: SubmitButtonProps) {
  const { pending } = useFormStatus();

  return (
    <Button
      type="submit"
      aria-busy={pending}
      disabled={pending || disabled}
      className={cn("relative", className)}
      {...props}
    >
      {/* Keep the label in the layout while hidden so the button never resizes. */}
      <span className={cn("inline-flex items-center gap-1.5", pending && "invisible")}>
        {children}
      </span>
      {pending ? (
        <>
          <LoaderCircle
            aria-hidden
            className="absolute inset-0 m-auto size-4 animate-spin"
          />
          <span className="sr-only">{pendingLabel}</span>
        </>
      ) : null}
    </Button>
  );
}

export { SubmitButton };
