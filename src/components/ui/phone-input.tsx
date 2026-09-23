"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";

/**
 * US phone input that displays a (XXX) XXX-XXXX mask while the user types.
 *
 * The visible field is just for display. We render a hidden `<input>` carrying
 * the digits-only value under the given `name` so server actions and FormData
 * always see a clean string (e.g. "3055551234"). Empty input submits as "".
 * A foreign number (one typed or stored with a "+" and a country code other
 * than 1) submits whole, plus included: "+4791234567".
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

/**
 * The value the form saves: a US number's digits, or a foreign number whole
 * with its "+".
 *
 * A number that names a country code other than 1 keeps the plus, because it
 * is the only thing that says "foreign" once the punctuation is gone. Norway,
 * Denmark and Singapore numbers are ten digits with the country code, so
 * "+47 912 34 567" without its plus reads as a US number and the guest's texts
 * go to a stranger. Everything else goes through `digitsOnly`, as before.
 * Mirrors `storablePhone` in supabase/functions/_shared/phone.ts.
 */
function toValue(raw: string): string {
  const plus = (raw ?? "").indexOf("+");
  if (plus !== -1) {
    const international = raw.slice(plus + 1).replace(/\D+/g, "").slice(0, MAX_DIGITS);
    // A lone "+" is someone starting to type a foreign number.
    if (!international.startsWith("1")) return `+${international}`;
  }
  return digitsOnly(raw);
}

function formatUsPhone(digits: string): string {
  const d = digits;
  if (d.length === 0) return "";
  if (d.startsWith("+")) return d;
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
  const [value, setValue] = useState(() => toValue(defaultValue ?? ""));

  return (
    <>
      <input
        id={id}
        type="tel"
        inputMode="tel"
        autoComplete={autoComplete}
        placeholder={placeholder}
        required={required}
        value={formatUsPhone(value)}
        onChange={(e) => setValue(toValue(e.target.value))}
        className={cn(
          "h-10 w-full rounded-md border bg-background px-3 text-sm outline-none transition placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        aria-describedby={`${id ?? name}-help`}
      />
      <input type="hidden" name={name} value={value === "+" ? "" : value} />
    </>
  );
}
