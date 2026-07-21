"use client";

import Link from "next/link";
import { useActionState, useRef, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PhoneInput } from "@/components/ui/phone-input";
import { cn } from "@/lib/utils";

import {
  deleteBusinessAction,
  updateBusinessAction,
  type DeleteBusinessState,
  type UpdateBusinessState,
} from "./actions";

const ALLOWED_LOGO_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/svg+xml",
];
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

const INITIAL: UpdateBusinessState = {};

type EditBusinessFormProps = {
  business: {
    id: string;
    name: string;
    phone: string | null;
    contact_email: string | null;
    google_review_url: string | null;
    logo_url: string | null;
  };
};

export function EditBusinessForm({ business }: EditBusinessFormProps) {
  const update = updateBusinessAction.bind(null, business.id);
  const [state, formAction, isPending] = useActionState(update, INITIAL);

  const [newLogoPreview, setNewLogoPreview] = useState<string | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const showingCurrentLogo =
    !removeLogo && !newLogoPreview && Boolean(business.logo_url);

  function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    setLogoError(null);
    const file = e.target.files?.[0];
    if (!file) {
      setNewLogoPreview(null);
      return;
    }
    if (!ALLOWED_LOGO_TYPES.includes(file.type)) {
      setLogoError("Choose a PNG, JPG, WebP, or SVG image.");
      e.target.value = "";
      setNewLogoPreview(null);
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError("Image must be 2 MB or smaller.");
      e.target.value = "";
      setNewLogoPreview(null);
      return;
    }
    setRemoveLogo(false);
    const reader = new FileReader();
    reader.onload = () =>
      setNewLogoPreview(
        typeof reader.result === "string" ? reader.result : null,
      );
    reader.readAsDataURL(file);
  }

  function clearNewLogo() {
    setNewLogoPreview(null);
    setLogoError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function toggleRemoveLogo() {
    setRemoveLogo((v) => !v);
    setNewLogoPreview(null);
    setLogoError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleDelete() {
    if (
      !confirm(
        `Delete "${business.name}"? This cannot be undone. Tours and bookings attached to this business must be removed first.`,
      )
    ) {
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      const res: DeleteBusinessState = await deleteBusinessAction(business.id);
      if (res?.error) setDeleteError(res.error);
    } finally {
      setDeleting(false);
    }
  }

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
              defaultValue={business.name}
              required
            />
          </Field>

          <Field
            label="Support phone"
            htmlFor="phone"
            hint="The number customers should call for help."
            error={state.fieldErrors?.phone}
          >
            <PhoneInput
              id="phone"
              name="phone"
              defaultValue={business.phone ?? ""}
            />
          </Field>

          <Field
            label="Support email"
            htmlFor="contact_email"
            hint="Shown to guests on their booking page."
            error={state.fieldErrors?.contact_email}
          >
            <Input
              id="contact_email"
              name="contact_email"
              type="email"
              defaultValue={business.contact_email ?? ""}
              placeholder="e.g. reservations@yourbusiness.com"
            />
          </Field>

          <Field
            label="Google review link"
            htmlFor="google_review_url"
            hint="Where happy customers are sent to leave a review. Until this is set, this business never gets review texts."
            error={state.fieldErrors?.google_review_url}
          >
            <Input
              id="google_review_url"
              name="google_review_url"
              type="url"
              defaultValue={business.google_review_url ?? ""}
              placeholder="e.g. https://g.page/r/.../review"
            />
          </Field>

          <Field
            label="Logo"
            htmlFor="logo"
            hint="PNG, JPG, WebP, or SVG. Up to 2 MB. Leave blank to keep the current logo."
            error={logoError ?? state.fieldErrors?.logo}
          >
            <div className="flex items-center gap-4">
              <LogoSlot
                newPreview={newLogoPreview}
                currentUrl={business.logo_url}
                showCurrent={showingCurrentLogo}
                removed={removeLogo}
              />
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
                <div className="flex items-center gap-3 text-xs">
                  {newLogoPreview && (
                    <button
                      type="button"
                      onClick={clearNewLogo}
                      className="text-muted-foreground underline"
                    >
                      Undo new file
                    </button>
                  )}
                  {business.logo_url && !newLogoPreview && (
                    <button
                      type="button"
                      onClick={toggleRemoveLogo}
                      className="text-muted-foreground underline"
                    >
                      {removeLogo ? "Keep current logo" : "Remove logo"}
                    </button>
                  )}
                </div>
              </div>
            </div>
            <input
              type="hidden"
              name="remove_logo"
              value={removeLogo ? "1" : "0"}
            />
          </Field>

          {state.error && (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {state.error}
            </p>
          )}
          {state.saved && (
            <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              Changes saved.
            </p>
          )}

          <div className="flex items-center gap-2">
            <Button type="submit" disabled={isPending}>
              {isPending ? "Saving..." : "Save changes"}
            </Button>
            <Link
              href="/admin/businesses"
              className={cn(buttonVariants({ variant: "outline" }))}
            >
              Cancel
            </Link>
          </div>
        </form>

        <hr className="my-6" />

        <div className="space-y-2">
          <h2 className="text-sm font-semibold">Danger zone</h2>
          <p className="text-xs text-muted-foreground">
            Deleting a business cannot be undone. You must remove its tours and
            bookings first.
          </p>
          {deleteError && (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {deleteError}
            </p>
          )}
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={handleDelete}
            disabled={deleting}
          >
            {deleting ? "Deleting..." : "Delete business"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function LogoSlot({
  newPreview,
  currentUrl,
  showCurrent,
  removed,
}: {
  newPreview: string | null;
  currentUrl: string | null;
  showCurrent: boolean;
  removed: boolean;
}) {
  if (newPreview) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={newPreview}
        alt="New logo preview"
        className="h-16 w-16 rounded-md border bg-background object-cover"
      />
    );
  }
  if (showCurrent && currentUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={currentUrl}
        alt="Current logo"
        className="h-16 w-16 rounded-md border bg-background object-cover"
      />
    );
  }
  return (
    <div className="flex h-16 w-16 items-center justify-center rounded-md border border-dashed bg-muted text-xs text-muted-foreground">
      {removed ? "removed" : "no logo"}
    </div>
  );
}
