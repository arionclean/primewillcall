"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { MeetingPointPicker } from "@/components/admin/meeting-point-picker";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { FormSection } from "@/components/ui/form-section";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { createTourAction, type CreateTourState } from "./actions";

const INITIAL: CreateTourState = {};

const DEFAULT_SLOTS = [
  { start: "09:00", duration: "120" },
  { start: "13:00", duration: "120" },
];

type SlotRow = { start: string; duration: string };
type BusinessOption = { id: string; name: string };

export function NewTourForm({
  businesses,
}: {
  businesses: BusinessOption[];
}) {
  const [state, formAction, isPending] = useActionState(
    createTourAction,
    INITIAL,
  );
  const [slots, setSlots] = useState<SlotRow[]>(DEFAULT_SLOTS);
  const [selectedBusinesses, setSelectedBusinesses] = useState<Set<string>>(
    () => new Set(),
  );

  function toggleBusiness(id: string) {
    setSelectedBusinesses((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function addSlot() {
    setSlots((s) => [...s, { start: "", duration: "60" }]);
  }
  function removeSlot(i: number) {
    setSlots((s) => s.filter((_, idx) => idx !== i));
  }
  function updateSlot(i: number, patch: Partial<SlotRow>) {
    setSlots((s) => s.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }

  return (
    <form action={formAction} className="space-y-6">
      <FormSection
        title="Tour basics"
        contentClassName="grid gap-5 sm:grid-cols-2"
      >
          <Field
            label="Name"
            htmlFor="name"
            error={state.fieldErrors?.name}
            className="sm:col-span-2"
          >
            <Input
              id="name"
              name="name"
              placeholder="e.g. Sunset Boat Tour"
              required
              autoFocus
            />
          </Field>

          <Field
            label="Capacity"
            htmlFor="capacity"
            error={state.fieldErrors?.capacity}
            className="sm:col-span-2"
          >
            <Input
              id="capacity"
              name="capacity"
              type="number"
              min="1"
              placeholder="e.g. 100"
              required
            />
          </Field>

          <Field
            label="Add to businesses"
            htmlFor=""
            hint="A variant gets created for each. You can edit their names and prices afterwards."
            className="sm:col-span-2"
          >
            {businesses.length === 0 ? (
              <p className="rounded-md border border-dashed bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
                No businesses exist yet. Save the tour now and add variants
                after you create a business.
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {businesses.map((b) => {
                  const checked = selectedBusinesses.has(b.id);
                  return (
                    <label
                      key={b.id}
                      className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition hover:bg-muted/50"
                    >
                      <input
                        type="checkbox"
                        name="business_ids"
                        value={b.id}
                        checked={checked}
                        onChange={() => toggleBusiness(b.id)}
                        className="h-4 w-4 accent-primary"
                      />
                      <span className="truncate">{b.name}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </Field>
      </FormSection>

      <FormSection
        title="Instructions & meeting point"
        contentClassName="space-y-5"
      >
          <Field
            label="Instructions"
            htmlFor="instructions"
            hint="Pre-departure info customers and staff see. Plain text."
          >
            <Textarea
              id="instructions"
              name="instructions"
              placeholder="What to bring, when to arrive, dress code, etc."
              rows={4}
            />
          </Field>
          <MeetingPointPicker />
      </FormSection>

      <FormSection title="Timeslots" contentClassName="space-y-3">
          <p className="text-xs text-muted-foreground">
            Recurring departure times. Businesses cannot change these.
          </p>
          {state.fieldErrors?.slot_dup && (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {state.fieldErrors.slot_dup}
            </p>
          )}
          <div className="space-y-3">
            {slots.map((slot, i) => (
              <div key={i} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
                <Field
                  label={i === 0 ? "Start time" : ""}
                  htmlFor={`slot_${i}_start`}
                  error={state.fieldErrors?.[`slot_${i}_start`]}
                >
                  <Input
                    id={`slot_${i}_start`}
                    name={`slot_${i}_start`}
                    type="time"
                    value={slot.start}
                    onChange={(e) => updateSlot(i, { start: e.target.value })}
                  />
                </Field>
                <Field
                  label={i === 0 ? "Duration (min)" : ""}
                  htmlFor={`slot_${i}_duration`}
                  error={state.fieldErrors?.[`slot_${i}_duration`]}
                >
                  <Input
                    id={`slot_${i}_duration`}
                    name={`slot_${i}_duration`}
                    type="number"
                    min="1"
                    value={slot.duration}
                    onChange={(e) => updateSlot(i, { duration: e.target.value })}
                  />
                </Field>
                <div className={i === 0 ? "pt-7" : ""}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeSlot(i)}
                    disabled={slots.length === 1}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <Button type="button" variant="outline" size="sm" onClick={addSlot}>
            + Add timeslot
          </Button>
      </FormSection>

      {state.error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={isPending}>
          {isPending ? "Saving..." : "Save tour"}
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
