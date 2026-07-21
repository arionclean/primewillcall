"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { FormSection } from "@/components/ui/form-section";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

import {
  deleteStaffAction,
  updateStaffAction,
  type DeleteStaffState,
  type UpdateStaffState,
} from "./actions";

const INITIAL: UpdateStaffState = {};

type StaffRole = "business_manager" | "check_in";

const ROLE_OPTIONS: { value: StaffRole; label: string; hint: string }[] = [
  {
    value: "business_manager",
    label: "Business manager",
    hint: "Manages one business: its tours, bookings, customers.",
  },
  {
    value: "check_in",
    label: "Check-in staff",
    hint: "Checks customers in for specific tours.",
  },
];

const PASSWORD_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%";

function generatePassword(): string {
  const len = 12;
  if (typeof window === "undefined" || !window.crypto?.getRandomValues) {
    let out = "";
    for (let i = 0; i < len; i++)
      out += PASSWORD_ALPHABET[Math.floor(Math.random() * PASSWORD_ALPHABET.length)];
    return out;
  }
  const buf = new Uint32Array(len);
  window.crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += PASSWORD_ALPHABET[buf[i] % PASSWORD_ALPHABET.length];
  }
  return out;
}

type Props = {
  staff: {
    id: string;
    full_name: string;
    email: string;
    role: StaffRole;
    business_id: string | null;
    is_active: boolean;
    can_create_bookings: boolean;
    can_edit_bookings: boolean;
    can_check_in: boolean;
    can_delete_bookings: boolean;
  };
  businesses: { id: string; name: string }[];
  tours: { id: string; name: string }[];
  assignedTourIds: string[];
};

const CAPABILITY_OPTIONS: {
  name: "can_create_bookings" | "can_edit_bookings" | "can_check_in" | "can_delete_bookings";
  label: string;
  hint: string;
}[] = [
  {
    name: "can_create_bookings",
    label: "Create bookings",
    hint: "Add new bookings from the Schedule page.",
  },
  {
    name: "can_edit_bookings",
    label: "Edit bookings",
    hint: "Change details, times, and payment status on existing bookings.",
  },
  {
    name: "can_check_in",
    label: "Check guests in",
    hint: "Mark guests as arrived from the Bookings page.",
  },
  {
    name: "can_delete_bookings",
    label: "Delete bookings",
    hint: "Remove bookings entirely. Leave off unless they really need it.",
  },
];

export function EditStaffForm({
  staff,
  businesses,
  tours,
  assignedTourIds,
}: Props) {
  const update = updateStaffAction.bind(null, staff.id);
  const [state, formAction, isPending] = useActionState(update, INITIAL);
  const [role, setRole] = useState<StaffRole>(staff.role);
  const [isActive, setIsActive] = useState<boolean>(staff.is_active);
  const [selectedTours, setSelectedTours] = useState<Set<string>>(
    () => new Set(assignedTourIds),
  );
  const [password, setPassword] = useState<string>("");
  const [copied, setCopied] = useState(false);

  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function toggleTour(id: string) {
    setSelectedTours((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function copyPassword() {
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // best effort
    }
  }

  async function handleDelete() {
    if (
      !confirm(
        `Delete "${staff.full_name}"? They will no longer be able to sign in. This cannot be undone.`,
      )
    ) {
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      const res: DeleteStaffState = await deleteStaffAction(staff.id);
      if (res?.error) setDeleteError(res.error);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <form action={formAction} className="space-y-6">
        <FormSection
          title="Basics"
          contentClassName="grid gap-5 sm:grid-cols-2"
        >
          <Field
            label="Full name"
            htmlFor="full_name"
            error={state.fieldErrors?.full_name}
          >
            <Input
              id="full_name"
              name="full_name"
              defaultValue={staff.full_name}
              required
              autoFocus
            />
          </Field>

          <Field label="Email" htmlFor="email_display">
            <Input
              id="email_display"
              type="email"
              value={staff.email}
              disabled
              readOnly
            />
          </Field>

          <Field
            label="Role"
            htmlFor="role"
            hint={
              ROLE_OPTIONS.find((r) => r.value === role)?.hint ?? undefined
            }
            error={state.fieldErrors?.role}
          >
            <Select
              id="role"
              name="role"
              value={role}
              onChange={(e) => setRole(e.target.value as StaffRole)}
              required
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Business"
            htmlFor="business_id"
            error={state.fieldErrors?.business_id}
          >
            <Select
              id="business_id"
              name="business_id"
              defaultValue={staff.business_id ?? ""}
              required
            >
              <option value="" disabled>
                Pick a business
              </option>
              {businesses.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Active" htmlFor="is_active" className="sm:col-span-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                id="is_active"
                name="is_active"
                type="checkbox"
                value="1"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              {isActive
                ? "Active — they can sign in."
                : "Inactive — they cannot sign in."}
            </label>
          </Field>

          <Field
            label="Reset password (optional)"
            htmlFor="password"
            hint="Leave blank to keep their current password. Setting one here updates it immediately."
            error={state.fieldErrors?.password}
            className="sm:col-span-2"
          >
            <div className="flex gap-2">
              <Input
                id="password"
                name="password"
                type="text"
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 6 characters"
                minLength={6}
                className="font-mono tracking-tight"
              />
              <Button
                type="button"
                variant="outline"
                size="default"
                onClick={() => setPassword(generatePassword())}
              >
                Generate
              </Button>
              <Button
                type="button"
                variant="outline"
                size="default"
                onClick={copyPassword}
                disabled={!password}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </Field>
        </FormSection>

        <FormSection
          title="Permissions"
          description="What this team member can do with bookings. Changes apply the next time they load a page."
          contentClassName="grid gap-3 sm:grid-cols-2"
        >
          {CAPABILITY_OPTIONS.map((cap) => (
            <label
              key={cap.name}
              className="flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 text-sm transition hover:bg-muted/50"
            >
              <input
                type="checkbox"
                name={cap.name}
                value="1"
                defaultChecked={staff[cap.name]}
                className="mt-0.5 h-4 w-4 accent-primary"
              />
              <span>
                <span className="block font-medium">{cap.label}</span>
                <span className="block text-xs text-muted-foreground">
                  {cap.hint}
                </span>
              </span>
            </label>
          ))}
        </FormSection>

        {role === "check_in" && (
          <FormSection
            title="Tours they check in for"
            description="Only bookings on these tours will appear in their dashboard."
            contentClassName="space-y-3"
          >
            {tours.length === 0 ? (
              <p className="rounded-md border border-dashed bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
                No active tours exist yet.
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {tours.map((t) => {
                  const checked = selectedTours.has(t.id);
                  return (
                    <label
                      key={t.id}
                      className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition hover:bg-muted/50"
                    >
                      <input
                        type="checkbox"
                        name="tour_ids"
                        value={t.id}
                        checked={checked}
                        onChange={() => toggleTour(t.id)}
                        className="h-4 w-4 accent-primary"
                      />
                      <span className="truncate">{t.name}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </FormSection>
        )}

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
            href="/admin/staff"
            className={cn(buttonVariants({ variant: "outline" }))}
          >
            Back to team
          </Link>
        </div>
      </form>

      <Card>
        <CardContent className="space-y-3 py-6">
          <h2 className="text-sm font-semibold">Danger zone</h2>
          <p className="text-xs text-muted-foreground">
            Deleting a team member removes their login and disconnects them
            from the platform. Past bookings they created or checked in stay
            in place but lose the link.
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
            {deleting ? "Deleting..." : "Delete team member"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
