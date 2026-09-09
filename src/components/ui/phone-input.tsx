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

/** E.164 allows at most 15 digits, country code included. */
const MAX_DIGITS = 15;

/**
 * Digits of a phone number, with the US country code removed.
 *
 * A stored number usually arrives as "+13055551234". Dropping the "+" leaves
 * 11 digits, so a blind cut to 10 would keep the country code as part of the
 * area code and throw away the real last digit. Strip the leading "1" first:
 * no US area code starts with 1, so this is never ambiguous.
 */
function digitsOnly(raw: string): string {
  const d = (raw ?? "").replace(/\D+/g, "").slice(0, MAX_DIGITS);
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
}

function formatUsPhone(digits: string): string {
  const d = digits;
  if (d.length === 0) return "";
  // Longer than a US number: an international one. Show it whole rather than
  // masking it, so editing a guest's foreign number cannot truncate it.
  if (d.length > 10) return `+${d}`;
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
