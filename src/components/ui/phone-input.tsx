"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";

/**
 * US phone input that displays a (XXX) XXX-XXXX mask while the user types.
 *
 * The visible field is just for display. We render a hidden `<input>` carrying
 * the digits-only value under the given `name` so server actions and FormData
 * always see a clean string (e.g. "3055551234"). Empty input submits as "".
 */
type PhoneInputProps = {
  name: string;
  id?: string;
  defaultValue?: string | null;
  placeholder?: string;
  required?: boolean;
  className?: string;
  autoComplete?: string;
};

function digitsOnly(raw: string): string {
  return (raw ?? "").replace(/\D+/g, "").slice(0, 10);
}

function formatUsPhone(digits: string): string {
  const d = digits.slice(0, 10);
  if (d.length === 0) return "";
  if (d.length <= 3) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export function PhoneInput({
  name,
  id,
  defaultValue,
  placeholder = "(305) 555-1234",
  required,
  className,
  autoComplete = "tel",
}: PhoneInputProps) {
  const initialDigits = digitsOnly(defaultValue ?? "");
  const [digits, setDigits] = useState(initialDigits);

  return (
    <>
      <input
        id={id}
        type="tel"
        inputMode="numeric"
        autoComplete={autoComplete}
        placeholder={placeholder}
        required={required}
        value={formatUsPhone(digits)}
        onChange={(e) => setDigits(digitsOnly(e.target.value))}
        className={cn(
          "h-10 w-full rounded-md border bg-background px-3 text-sm outline-none transition placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        aria-describedby={`${id ?? name}-help`}
      />
      <input type="hidden" name={name} value={digits} />
    </>
  );
}
