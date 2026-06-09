"use client";

import { useActionState, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { FormSection } from "@/components/ui/form-section";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { PhoneInput } from "@/components/ui/phone-input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { Database } from "@/lib/supabase/database.types";

import { createBookingAction, type CreateBookingState } from "./actions";

type StaffRole = Database["public"]["Enums"]["staff_role"];

export type ScheduleFormTour = {
  id: string; // business_tours.id
  name: string;
  businessId: string;
  businessName: string;
  masterTourId: string;
  masterTourName: string;
  masterIsActive: boolean;
  variantIsActive: boolean;
  timeslots: { start_time: string; duration_minutes: number }[];
  tiers: {
    id: string;
    label: string;
    description: string | null;
    price_cents: number;
  }[];
};

const INITIAL: CreateBookingState = {};

function hhmm(t: string): string {
  return /^\d{2}:\d{2}/.test(t) ? t.slice(0, 5) : t;
}

function todayInNewYork(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function ScheduleForm({
  role,
  tours,
}: {
  staffId: string;
  role: StaffRole;
  tours: ScheduleFormTour[];
}) {
  const [state, formAction, isPending] = useActionState(
    createBookingAction,
    INITIAL,
  );

  const [tourId, setTourId] = useState<string>(tours[0]?.id ?? "");
  const [date, setDate] = useState<string>(todayInNewYork());
  const [slotIndex, setSlotIndex] = useState<number>(0);
  const [pax, setPax] = useState<Record<string, number>>({});
  const [customer, setCustomer] = useState({
    full_name: "",
    email: "",
    phone: "",
  });
  const [notes, setNotes] = useState("");

  const selected = useMemo(
    () => tours.find((t) => t.id === tourId) ?? tours[0],
    [tours, tourId],
  );

  const slot = selected?.timeslots[slotIndex] ?? selected?.timeslots[0];

  // Group by business for the owner picker.
  const groups = useMemo(() => {
    const map = new Map<string, { businessName: string; items: ScheduleFormTour[] }>();
    for (const t of tours) {
      const k = t.businessId;
      const g = map.get(k);
      if (g) g.items.push(t);
      else map.set(k, { businessName: t.businessName, items: [t] });
    }
    return Array.from(map.values());
  }, [tours]);

  // Live total.
  const totalCents = useMemo(() => {
    if (!selected) return 0;
    let sum = 0;
    for (const tier of selected.tiers) {
      const qty = pax[tier.id] ?? 0;
      if (qty > 0) sum += qty * tier.price_cents;
    }
    return sum;
  }, [pax, selected]);

  const anyQty = useMemo(() => {
    if (!selected) return false;
    return selected.tiers.some((t) => (pax[t.id] ?? 0) > 0);
  }, [pax, selected]);

  function setQty(tierId: string, next: number) {
    const v = Math.max(0, Math.floor(Number.isFinite(next) ? next : 0));
    setPax((p) => ({ ...p, [tierId]: v }));
  }

  if (!selected) return null;

  const noSlots = selected.timeslots.length === 0;

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="business_tour_id" value={selected.id} />
      <input type="hidden" name="date" value={date} />
      <input
        type="hidden"
        name="slot_start"
        value={slot ? slot.start_time : ""}
      />
      <input
        type="hidden"
        name="slot_duration"
        value={slot ? String(slot.duration_minutes) : ""}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left column: booking details */}
        <div className="space-y-6">
          <FormSection title="Booking details" contentClassName="space-y-5">
            <Field
              label="Tour"
              htmlFor="tour-picker"
              error={state.fieldErrors?.business_tour_id}
            >
              <select
                id="tour-picker"
                value={tourId}
                onChange={(e) => {
                  setTourId(e.target.value);
                  setSlotIndex(0);
                  setPax({});
                }}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {role === "owner" ? (
                  groups.map((g) => (
                    <optgroup key={g.businessName} label={g.businessName}>
                      {g.items.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </optgroup>
                  ))
                ) : (
                  tours.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))
                )}
              </select>
              <div className="flex items-center justify-between pt-1 text-xs text-muted-foreground">
                <span>{selected.businessName}</span>
                {selected.masterTourName &&
                  selected.masterTourName !== selected.name && (
                    <span>Master: {selected.masterTourName}</span>
                  )}
              </div>
            </Field>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field
                label="Date"
                htmlFor="date-input"
                error={state.fieldErrors?.date}
              >
                <DateField
                  id="date-input"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  required
                />
              </Field>
              <Field
                label="Timeslot"
                htmlFor=""
                error={state.fieldErrors?.slot_start}
              >
                {noSlots ? (
                  <p className="rounded-md border border-dashed bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
                    No timeslots configured for this tour. Ask Prime to add
                    them.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {selected.timeslots.map((s, i) => {
                      const active = i === slotIndex;
                      return (
                        <button
                          key={`${s.start_time}-${i}`}
                          type="button"
                          onClick={() => setSlotIndex(i)}
                          className={cn(
                            "rounded-full border px-3 py-1.5 text-sm transition",
                            active
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border bg-background text-foreground hover:bg-muted",
                          )}
                        >
                          {hhmm(s.start_time)}
                        </button>
                      );
                    })}
                  </div>
                )}
              </Field>
            </div>
          </FormSection>

          <FormSection title="Guests" contentClassName="space-y-4">
            {selected.tiers.length === 0 ? (
              <p className="rounded-md border border-dashed bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
                No pax tiers configured for this tour. Ask Prime to add them.
              </p>
            ) : (
              <div className="space-y-3">
                {selected.tiers.map((tier) => {
                  const qty = pax[tier.id] ?? 0;
                  const line = qty * tier.price_cents;
                  return (
                    <div
                      key={tier.id}
                      className="flex flex-wrap items-center gap-3 rounded-md border p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">
                          {capitalize(tier.label)}
                        </p>
                        {tier.description && (
                          <p className="text-xs text-muted-foreground">
                            {tier.description}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="icon-sm"
                          onClick={() => setQty(tier.id, qty - 1)}
                          disabled={qty <= 0}
                          aria-label={`Decrease ${tier.label}`}
                        >
                          {"−"}
                        </Button>
                        <Input
                          name={`pax_${tier.id}`}
                          type="number"
                          inputMode="numeric"
                          min={0}
                          value={qty}
                          onChange={(e) =>
                            setQty(tier.id, Number(e.target.value))
                          }
                          className="h-8 w-14 text-center"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="icon-sm"
                          onClick={() => setQty(tier.id, qty + 1)}
                          aria-label={`Increase ${tier.label}`}
                        >
                          +
                        </Button>
                      </div>
                      <div className="w-32 text-right text-sm tabular-nums text-muted-foreground">
                        {"× "}
                        {formatMoney(tier.price_cents)}
                        {" = "}
                        <span className="text-foreground">
                          {formatMoney(line)}
                        </span>
                      </div>
                    </div>
                  );
                })}
                <Card>
                  <CardContent className="flex items-center justify-between py-3">
                    <span className="text-sm font-medium">Total</span>
                    <span className="text-lg font-semibold tabular-nums">
                      {formatMoney(totalCents)}
                    </span>
                  </CardContent>
                </Card>
              </div>
            )}
          </FormSection>
        </div>

        {/* Right column: customer + notes */}
        <div className="space-y-6">
          <FormSection title="Customer" contentClassName="space-y-5">
            <Field
              label="Full name"
              htmlFor="customer_full_name"
              error={state.fieldErrors?.customer_full_name}
            >
              <Input
                id="customer_full_name"
                name="customer_full_name"
                value={customer.full_name}
                onChange={(e) =>
                  setCustomer((c) => ({ ...c, full_name: e.target.value }))
                }
                required
                autoComplete="name"
              />
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field
                label="Phone"
                htmlFor="customer_phone"
                error={state.fieldErrors?.customer_phone}
              >
                <PhoneInput
                  id="customer_phone"
                  name="customer_phone"
                  defaultValue={customer.phone}
                />
              </Field>
              <Field
                label="Email"
                htmlFor="customer_email"
                error={state.fieldErrors?.customer_email}
              >
                <Input
                  id="customer_email"
                  name="customer_email"
                  type="email"
                  value={customer.email}
                  onChange={(e) =>
                    setCustomer((c) => ({ ...c, email: e.target.value }))
                  }
                  autoComplete="email"
                />
              </Field>
            </div>
          </FormSection>

          <FormSection title="Notes" contentClassName="space-y-3">
            <Field label="Internal notes" htmlFor="notes">
              <Textarea
                id="notes"
                name="notes"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional internal notes."
              />
            </Field>
          </FormSection>
        </div>
      </div>

      {state.error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button
          type="submit"
          disabled={isPending || noSlots || !anyQty}
        >
          {isPending ? "Saving..." : "Save booking"}
        </Button>
      </div>
    </form>
  );
}
