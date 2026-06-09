"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { FormSection } from "@/components/ui/form-section";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import {
  updateManagerTourAction,
  type UpdateManagerTourState,
} from "./manager-actions";

const INITIAL: UpdateManagerTourState = {};

type Tier = {
  id: string;
  label: string;
  description: string | null;
  price_cents: number;
  sort_order: number;
};

type Timeslot = {
  start_time: string;
  duration_minutes: number;
};

type ManagerEditTourFormProps = {
  businessTour: {
    id: string;
    name: string;
    is_active: boolean;
  };
  tourId: string;
  tour: {
    name: string;
    capacity: number;
    instructions: string | null;
    meeting_point_address: string | null;
  };
  timeslots: Timeslot[];
  tiers: Tier[];
};

function hhmm(t: string): string {
  return /^\d{2}:\d{2}/.test(t) ? t.slice(0, 5) : t;
}

function centsToDollars(c: number): string {
  return (c / 100).toFixed(2);
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

export function ManagerEditTourForm({
  businessTour,
  tourId,
  tour,
  timeslots,
  tiers,
}: ManagerEditTourFormProps) {
  const action = updateManagerTourAction.bind(null, businessTour.id, tourId);
  const [state, formAction, isPending] = useActionState(action, INITIAL);

  const [isActive, setIsActive] = useState(businessTour.is_active);

  return (
    <form action={formAction} className="space-y-6">
      <FormSection title="Tour basics" contentClassName="grid gap-5 sm:grid-cols-2">
        <Field
          label="Name"
          htmlFor="name"
          error={state.fieldErrors?.name}
          hint="What customers see for this tour."
          className="sm:col-span-2"
        >
          <Input
            id="name"
            name="name"
            defaultValue={businessTour.name}
            required
          />
        </Field>

        <Field
          label="Active"
          htmlFor="is_active"
          hint="Uncheck to hide this tour from bookings."
          className="sm:col-span-2"
        >
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
            {isActive ? "Active" : "Inactive"}
          </label>
        </Field>
      </FormSection>

      <FormSection title="Pricing" contentClassName="space-y-4">
        {tiers.length === 0 ? (
          <p className="rounded-md border border-dashed bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
            No price tiers set. Ask Prime to add them.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="hidden gap-3 px-1 text-xs font-medium text-muted-foreground sm:grid sm:grid-cols-[1fr_2fr_1fr]">
              <div>Tier</div>
              <div>Description</div>
              <div>Price (USD)</div>
            </div>
            {tiers.map((tier, i) => (
              <div
                key={tier.id}
                className="grid gap-3 sm:grid-cols-[1fr_2fr_1fr] sm:items-start"
              >
                <input
                  type="hidden"
                  name={`tier_id_${i}`}
                  value={tier.id}
                />
                <div className="pt-2 text-sm font-medium">
                  {capitalize(tier.label)}
                </div>
                <Field label="" htmlFor={`tier_description_${i}`}>
                  <Input
                    id={`tier_description_${i}`}
                    name={`tier_description_${i}`}
                    defaultValue={tier.description ?? ""}
                    placeholder="e.g. Ages 13+"
                  />
                </Field>
                <Field
                  label=""
                  htmlFor={`tier_price_${i}`}
                  error={state.fieldErrors?.[`tier_${i}_price`]}
                >
                  <Input
                    id={`tier_price_${i}`}
                    name={`tier_price_${i}`}
                    type="number"
                    step="0.01"
                    min="0"
                    defaultValue={centsToDollars(tier.price_cents)}
                    required
                  />
                </Field>
              </div>
            ))}
          </div>
        )}
      </FormSection>

      <FormSection title="Tour details" contentClassName="space-y-4">
        <p className="text-xs text-muted-foreground">
          Set by Prime. Contact them to change.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              Capacity
            </p>
            <p className="mt-1 text-sm">{tour.capacity}</p>
          </div>
          {tour.meeting_point_address && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">
                Meeting point
              </p>
              <p className="mt-1 text-sm">{tour.meeting_point_address}</p>
            </div>
          )}
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">
            Timeslots
          </p>
          {timeslots.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">None set.</p>
          ) : (
            <ul className="mt-1 space-y-1 text-sm">
              {timeslots.map((s, i) => (
                <li key={i}>
                  {hhmm(s.start_time)} ({s.duration_minutes} min)
                </li>
              ))}
            </ul>
          )}
        </div>
      </FormSection>

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
          href="/admin/tours"
          className={cn(buttonVariants({ variant: "outline" }))}
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
