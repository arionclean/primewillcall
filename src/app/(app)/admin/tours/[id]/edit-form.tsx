"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { MeetingPointPicker } from "@/components/admin/meeting-point-picker";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { FormSection } from "@/components/ui/form-section";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import {
  deleteTourAction,
  updateTourAction,
  type DeleteTourState,
  type UpdateTourState,
} from "./actions";

const INITIAL: UpdateTourState = {};

type SlotRow = { start: string; duration: string };

type EditTourFormProps = {
  tour: {
    id: string;
    name: string;
    capacity: number;
    is_active: boolean;
    instructions: string | null;
    meeting_point_address: string | null;
    meeting_point_lat: number | null;
    meeting_point_lng: number | null;
  };
  timeslots: { start_time: string; duration_minutes: number }[];
  businesses: { id: string; name: string }[];
  assignedBusinessIds: string[];
};

function hhmm(t: string): string {
  // "HH:MM:SS" -> "HH:MM"
  return /^\d{2}:\d{2}/.test(t) ? t.slice(0, 5) : t;
}

export function EditTourForm({
  tour,
  timeslots,
  businesses,
  assignedBusinessIds,
}: EditTourFormProps) {
  const update = updateTourAction.bind(null, tour.id);
  const [state, formAction, isPending] = useActionState(update, INITIAL);

  const [slots, setSlots] = useState<SlotRow[]>(() =>
    timeslots.length > 0
      ? timeslots.map((s) => ({
          start: hhmm(s.start_time),
          duration: String(s.duration_minutes),
        }))
      : [{ start: "", duration: "60" }],
  );
  const [isActive, setIsActive] = useState(tour.is_active);
  const [selectedBusinesses, setSelectedBusinesses] = useState<Set<string>>(
    () => new Set(assignedBusinessIds),
  );

  function toggleBusiness(id: string) {
    setSelectedBusinesses((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function addSlot() {
    setSlots((s) => [...s, { start: "", duration: "60" }]);
  }
  function removeSlot(i: number) {
    setSlots((s) => s.filter((_, idx) => idx !== i));
  }
  function updateSlot(i: number, patch: Partial<SlotRow>) {
    setSlots((s) => s.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }

  async function handleDelete() {
    if (
      !confirm(
        `Delete "${tour.name}"? This will also delete its timeslots. Variants and bookings must be removed first.`,
      )
    ) {
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      const res: DeleteTourState = await deleteTourAction(tour.id);
      if (res?.error) setDeleteError(res.error);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
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
                defaultValue={tour.name}
                required
              />
            </Field>

            <Field
              label="Capacity"
              htmlFor="capacity"
              error={state.fieldErrors?.capacity}
            >
              <Input
                id="capacity"
                name="capacity"
                type="number"
                min="1"
                defaultValue={tour.capacity}
                required
              />
            </Field>

            <Field
              label="Active"
              htmlFor="is_active"
              hint="Inactive tours are hidden from new assignments."
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

            <Field
              label="Assigned to businesses"
              htmlFor=""
              hint="Check the businesses that sell this tour. Unchecking removes a business (only if it has no bookings yet)."
              className="sm:col-span-2"
            >
              {businesses.length === 0 ? (
                <p className="rounded-md border border-dashed bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
                  No businesses exist yet.
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
                rows={4}
                defaultValue={tour.instructions ?? ""}
                placeholder="What to bring, when to arrive, dress code, etc."
              />
            </Field>
            <MeetingPointPicker
              defaultAddress={tour.meeting_point_address}
              defaultLat={tour.meeting_point_lat}
              defaultLng={tour.meeting_point_lng}
            />
        </FormSection>

        <FormSection title="Timeslots" contentClassName="space-y-3">
            <p className="text-xs text-muted-foreground">
              Saving replaces the existing timeslots with whatever is in this list.
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
                      onChange={(e) =>
                        updateSlot(i, { duration: e.target.value })
                      }
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
            Back to list
          </Link>
        </div>
      </form>

      <Card>
        <CardContent className="space-y-3 py-6">
          <h2 className="text-sm font-semibold">Danger zone</h2>
          <p className="text-xs text-muted-foreground">
            Deleting a tour also deletes its timeslots. Variants and bookings
            must be removed first.
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
            {deleting ? "Deleting..." : "Delete tour"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
