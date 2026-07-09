"use client";

import Link from "next/link";
import { useActionState, useRef, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PhoneInput } from "@/components/ui/phone-input";
import { cn } from "@/lib/utils";

import { createBusinessAction, type CreateBusinessState } from "./actions";

const INITIAL: CreateBusinessState = {};
const ALLOWED_LOGO_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/svg+xml",
];
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export function NewBusinessForm() {
  const [state, formAction, isPending] = useActionState(
    createBusinessAction,
    INITIAL,
  );
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    setLogoError(null);
    const file = e.target.files?.[0];
    if (!file) {
      setLogoPreview(null);
      return;
    }
    if (!ALLOWED_LOGO_TYPES.includes(file.type)) {
      setLogoError("Choose a PNG, JPG, WebP, or SVG image.");
      e.target.value = "";
      setLogoPreview(null);
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError("Image must be 2 MB or smaller.");
      e.target.value = "";
      setLogoPreview(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () =>
      setLogoPreview(
        typeof reader.result === "string" ? reader.result : null,
      );
    reader.readAsDataURL(file);
  }

  function clearLogo() {
    setLogoPreview(null);
    setLogoError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const logoServerError = state.fieldErrors?.logo;

  return (
    <Card>
      <CardContent className="py-6">
        <form action={formAction} className="space-y-5">
          <Field
            label="Business name"
            htmlFor="name"
            error={state.fieldErrors?.name}
          >
            <Input
              id="name"
              name="name"
              placeholder="e.g. Sunset Snorkel Co."
              required
              autoFocus
            />
          </Field>

          <Field
            label="Support phone"
            htmlFor="phone"
            hint="Optional. The number customers should call for help."
            error={state.fieldErrors?.phone}
          >
            <PhoneInput id="phone" name="phone" />
          </Field>

          <Field
            label="Support email"
            htmlFor="contact_email"
            hint="Optional. Shown to guests on their booking page."
            error={state.fieldErrors?.contact_email}
          >
            <Input
              id="contact_email"
              name="contact_email"
              type="email"
              placeholder="e.g. reservations@yourbusiness.com"
            />
          </Field>

          <Field
            label="Logo"
            htmlFor="logo"
            hint="PNG, JPG, WebP, or SVG. Up to 2 MB."
            error={logoError ?? logoServerError}
          >
            <div className="flex items-center gap-4">
              {logoPreview ? (
                // Data URL, safe to render via plain <img>.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={logoPreview}
                  alt="Logo preview"
                  className="h-16 w-16 rounded-md border bg-background object-cover"
                />
              ) : (
                <LogoPlaceholder />
              )}
              <div className="flex flex-col gap-1">
                <input
                  ref={fileInputRef}
                  id="logo"
                  name="logo"
                  type="file"
                  accept={ALLOWED_LOGO_TYPES.join(",")}
                  onChange={handleLogoChange}
                  className="text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-muted"
                />
                {logoPreview && (
                  <button
                    type="button"
                    onClick={clearLogo}
                    className="self-start text-xs text-muted-foreground underline"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          </Field>

          {state.error && (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {state.error}
            </p>
          )}

          <div className="flex items-center gap-2">
            <Button type="submit" disabled={isPending}>
              {isPending ? "Saving..." : "Save business"}
            </Button>
            <Link
              href="/admin/businesses"
              className={cn(buttonVariants({ variant: "outline" }))}
            >
              Cancel
            </Link>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function LogoPlaceholder() {
  return (
    <div className="flex h-16 w-16 items-center justify-center rounded-md border border-dashed bg-muted text-xs text-muted-foreground">
      no logo
    </div>
  );
}
