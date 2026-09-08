"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { Field } from "@/components/ui/field";
import { FormSection } from "@/components/ui/form-section";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

import { createStaffAction, type CreateStaffState } from "./actions";

// Avoid 0/O/1/l/I and ambiguous symbols. 10 chars = plenty of entropy.
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

const INITIAL: CreateStaffState = {};

type StaffRole = "owner" | "business_manager" | "check_in";

// Owner is intentionally NOT in this list. New owners can only be created
// directly in the Supabase dashboard, by design.
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

type CapabilityName =
  | "can_create_bookings"
  | "can_edit_bookings"
  | "can_check_in"
  | "can_void_bookings"
  | "can_add_to_peek"
  | "can_view_attachments"
  | "can_redeem_groupon"
  | "can_view_details"
  | "can_use_caja"
  | "can_manage_sales"
  | "can_manage_team"
  | "can_view_payments";

const CAPABILITY_OPTIONS: {
  name: CapabilityName;
  label: string;
  hint: string;
  /** Only these roles get the switch; the others never see the screen it gates. */
  roles?: StaffRole[];
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
    name: "can_void_bookings",
    label: "Void bookings",
    hint: "Mark a booking as voided (a mistake or a duplicate). The booking stays on record with who voided it and why; nothing is ever deleted. Only an owner can restore one.",
  },
  {
    name: "can_add_to_peek",
    label: "Add to Peek",
    hint: "Mark bookings as entered in Peek from the Bookings page.",
  },
  {
    name: "can_redeem_groupon",
    label: "Redeem Groupon vouchers",
    hint: "Show the Redemption Codes and the Redeem toggle on Groupon bookings.",
  },
  {
    name: "can_use_caja",
    roles: ["check_in"],
    label: "Use Caja",
    hint: "Open Caja: the desk's own cash and card for the day, and the end-of-night count. Check-in logins only.",
  },
  {
    name: "can_manage_sales",
    roles: ["business_manager"],
    label: "Refund, void and move sales",
    hint: "On the Payments page: refund a card or cash sale, void a cash sale, move a sale to another kiosk. The passcode is still asked. Managers.",
  },
  {
    name: "can_manage_team",
    roles: ["business_manager"],
    label: "Manage the team",
    hint: "On Team: add employees, change PINs, pause or remove them. Off: they can look but not change. Managers.",
  },
  {
    name: "can_view_payments",
    roles: ["business_manager"],
    label: "See Payments",
    hint: "Open the Payments page with their business's sales and totals. Off: the page is hidden. Managers.",
  },
  {
    name: "can_view_details",
    label: "See full booking details",
    hint: "Off: only the ID, name, phone, guests and check-in status show. Notes, emails and the edit form stay hidden.",
  },
  {
    name: "can_view_attachments",
    label: "See attachments",
    hint: "Open the photos attached to a booking, such as Groupon voucher screenshots.",
  },
];

type Props = {
  businesses: { id: string; name: string }[];
  /** Preselected role, e.g. an account from the Accounts tab. */
  defaultRole?: StaffRole | "";
  tours: { id: string; name: string }[];
  /** Inside a dialog: Cancel closes it instead of leaving the page. */
  onCancel?: () => void;
  submitLabel?: string;
};

export function NewStaffForm({
  businesses,
  tours,
  defaultRole = "",
  onCancel,
  submitLabel = "Save team member",
}: Props) {
  const [state, formAction] = useActionState(
    createStaffAction,
    INITIAL,
  );
  const [role, setRole] = useState<StaffRole | "">(defaultRole);
  const [selectedTours, setSelectedTours] = useState<Set<string>>(
    () => new Set(),
  );
  // Void defaults on for managers, off for check-in staff.
  const [caps, setCaps] = useState<Record<CapabilityName, boolean>>({
    can_create_bookings: true,
    can_edit_bookings: true,
    can_check_in: true,
    can_void_bookings: false,
    can_add_to_peek: true,
    can_view_attachments: true,
    can_redeem_groupon: false,
    can_view_details: true,
    can_use_caja: true,
    can_manage_sales: true,
    can_manage_team: true,
    can_view_payments: true,
  });
  const [password, setPassword] = useState<string>("");
  const [copied, setCopied] = useState(false);

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

  function toggleTour(id: string) {
    setSelectedTours((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const needsBusiness = role === "business_manager" || role === "check_in";
  const needsTours = role === "check_in";

  return (
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
            placeholder="e.g. Jane Doe"
            required
            autoFocus
          />
        </Field>

        <Field
          label="Email"
          htmlFor="email"
          hint="They'll sign in with this address."
          error={state.fieldErrors?.email}
        >
          <Input
            id="email"
            name="email"
            type="email"
            placeholder="jane@example.com"
            required
          />
        </Field>

        <Field
          label="Role"
          htmlFor="role"
          hint={
            ROLE_OPTIONS.find((r) => r.value === role)?.hint ??
            "Pick what they can access."
          }
          error={state.fieldErrors?.role}
        >
          <Select
            id="role"
            name="role"
            value={role}
            onChange={(e) => {
              const next = e.target.value as StaffRole;
              setRole(next);
              setCaps((prev) => ({
                ...prev,
                can_void_bookings: next === "business_manager",
              }));
            }}
            required
          >
            <option value="" disabled>
              Pick a role
            </option>
            {ROLE_OPTIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>

        {needsBusiness && (
          <Field
            label="Business"
            htmlFor="business_id"
            error={state.fieldErrors?.business_id}
            className="sm:col-span-2"
          >
            <Select id="business_id" name="business_id" defaultValue="" required>
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
        )}

        <Field
          label="Password"
          htmlFor="password"
          hint="Set the password they'll use to sign in. Leave blank to send them an email invite to set their own."
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

      {role !== "" && (
        <FormSection
          title="Permissions"
          description="What this team member can do with bookings. You can change these later."
          contentClassName="grid gap-3 sm:grid-cols-2"
        >
          {CAPABILITY_OPTIONS.filter((cap) => !cap.roles || (role !== "" && cap.roles.includes(role))).map((cap) => (
            <label
              key={cap.name}
              className="flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 text-sm transition hover:bg-muted/50"
            >
              <input
                type="checkbox"
                name={cap.name}
                value="1"
                checked={caps[cap.name]}
                onChange={(e) =>
                  setCaps((prev) => ({
                    ...prev,
                    [cap.name]: e.target.checked,
                  }))
                }
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
      )}

      {needsTours && (
        <FormSection
          title="Tours they check in for"
          description="Only bookings on these tours will appear in their dashboard."
          contentClassName="space-y-3"
        >
          {tours.length === 0 ? (
            <p className="rounded-md border border-dashed bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
              No active tours exist yet. You can assign tours later by editing
              this team member.
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

      <div className="flex items-center gap-2">
        <SubmitButton>{submitLabel}</SubmitButton>
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        ) : (
          <Link
            href="/admin/staff"
            className={cn(buttonVariants({ variant: "outline" }))}
          >
            Cancel
          </Link>
        )}
      </div>
    </form>
  );
}
