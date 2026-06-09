"use client";

import Link from "next/link";
import { useActionState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { FormSection } from "@/components/ui/form-section";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

import { createVariantAction, type CreateVariantState } from "./actions";

const INITIAL: CreateVariantState = {};

const DEFAULT_TIERS = [
  { label: "adult", description: "Ages 13+", price: "50.00" },
  { label: "child", description: "Ages 4-12", price: "25.00" },
  { label: "infant", description: "Under 4", price: "0.00" },
];

type BusinessOption = { id: string; name: string };

type NewVariantFormProps = {
  tourId: string;
  tourName: string;
  businesses: BusinessOption[];
};

export function NewVariantForm({
  tourId,
  tourName,
  businesses,
}: NewVariantFormProps) {
  const create = createVariantAction.bind(null, tourId);
  const [state, formAction, isPending] = useActionState(create, INITIAL);

  return (
    <form action={formAction} className="space-y-6">
      <FormSection
        title="Variant basics"
        contentClassName="grid gap-5 sm:grid-cols-2"
      >
          <Field
            label="Business"
            htmlFor="business_id"
            error={state.fieldErrors?.business_id}
            className="sm:col-span-2"
          >
            <Select id="business_id" name="business_id" defaultValue="">
              <option value="" disabled>
                Select a business
              </option>
              {businesses.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Variant name"
            htmlFor="name"
            hint={`This is the name customers will see. The master tour is "${tourName}".`}
            error={state.fieldErrors?.name}
            className="sm:col-span-2"
          >
            <Input
              id="name"
              name="name"
              placeholder="e.g. Miami Sunset Cruise with Mojito Bar"
              required
              autoFocus
            />
          </Field>
      </FormSection>

      <FormSection title="Pax tiers" contentClassName="space-y-4">
          <p className="text-xs text-muted-foreground">
            Prices are per person. Adjust as needed. Empty rows are ignored.
          </p>
          <div className="space-y-3">
            {DEFAULT_TIERS.map((t, i) => (
              <div key={i} className="grid gap-3 sm:grid-cols-[1fr_2fr_1fr]">
                <Field
                  label={i === 0 ? "Label" : ""}
                  htmlFor={`tier_${i}_label`}
                  error={state.fieldErrors?.[`tier_${i}_label`]}
                >
                  <Input
                    id={`tier_${i}_label`}
                    name={`tier_${i}_label`}
                    defaultValue={t.label}
                    placeholder="adult"
                  />
                </Field>
                <Field
                  label={i === 0 ? "Description" : ""}
                  htmlFor={`tier_${i}_description`}
                >
                  <Input
                    id={`tier_${i}_description`}
                    name={`tier_${i}_description`}
                    defaultValue={t.description}
                    placeholder="Optional"
                  />
                </Field>
                <Field
                  label={i === 0 ? "Price (USD)" : ""}
                  htmlFor={`tier_${i}_price`}
                  error={state.fieldErrors?.[`tier_${i}_price`]}
                >
                  <Input
                    id={`tier_${i}_price`}
                    name={`tier_${i}_price`}
                    type="text"
                    inputMode="decimal"
                    defaultValue={t.price}
                    placeholder="0.00"
                  />
                </Field>
              </div>
            ))}
          </div>
      </FormSection>

      {state.error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={isPending}>
          {isPending ? "Saving..." : "Save variant"}
        </Button>
        <Link
          href={`/admin/tours/${tourId}`}
          className={cn(buttonVariants({ variant: "outline" }))}
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
