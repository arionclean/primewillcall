"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { FormSection } from "@/components/ui/form-section";
import { Input } from "@/components/ui/input";

import {
  updateGrouponFeesAction,
  type UpdateGrouponFeesState,
} from "./actions";

export type GrouponProductRow = {
  id: string;
  productName: string;
  isActive: boolean;
  grouponFeeCents: number | null;
  businessId: string;
  businessName: string;
};

const INITIAL: UpdateGrouponFeesState = {};

function centsToDollars(c: number): string {
  return (c / 100).toFixed(2);
}

type RowState = { enabled: boolean; fee: string };

export function GrouponFeesForm({ rows }: { rows: GrouponProductRow[] }) {
  const [state, formAction, isPending] = useActionState(
    updateGrouponFeesAction,
    INITIAL,
  );

  const [rowState, setRowState] = useState<Record<string, RowState>>(() =>
    Object.fromEntries(
      rows.map((r) => [
        r.id,
        {
          enabled: r.grouponFeeCents !== null,
          fee: r.grouponFeeCents !== null ? centsToDollars(r.grouponFeeCents) : "",
        },
      ]),
    ),
  );

  // Stable display order (already sorted by the server) grouped by business.
  const groups: { businessName: string; items: GrouponProductRow[] }[] = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && last.businessName === r.businessName) last.items.push(r);
    else groups.push({ businessName: r.businessName, items: [r] });
  }

  const setRow = (id: string, patch: Partial<RowState>) =>
    setRowState((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  // The index a row occupies in the flat `rows` array (the action reads indexed keys).
  const indexOf = new Map(rows.map((r, i) => [r.id, i]));

  return (
    <form action={formAction} className="space-y-6">
      {groups.map((group) => (
        <FormSection
          key={group.businessName}
          title={group.businessName}
          contentClassName="space-y-3"
        >
          <div className="hidden gap-3 px-1 text-xs font-medium text-muted-foreground sm:grid sm:grid-cols-[1fr_auto_8rem]">
            <div>Product</div>
            <div className="text-center">Accept Groupon</div>
            <div>Fee per guest (USD)</div>
          </div>

          {group.items.map((row) => {
            const i = indexOf.get(row.id)!;
            const rs = rowState[row.id];
            return (
              <div
                key={row.id}
                className="grid items-center gap-3 border-b pb-3 last:border-b-0 sm:grid-cols-[1fr_auto_8rem]"
              >
                <input type="hidden" name={`bt_id_${i}`} value={row.id} />
                <div className="text-sm font-medium">
                  {row.productName}
                  {!row.isActive && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      (inactive)
                    </span>
                  )}
                </div>

                <label className="flex items-center justify-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name={`bt_enabled_${i}`}
                    value="1"
                    checked={rs.enabled}
                    onChange={(e) => setRow(row.id, { enabled: e.target.checked })}
                    className="h-4 w-4 accent-primary"
                  />
                  <span className="sm:hidden">Accept Groupon</span>
                </label>

                <Field label="" htmlFor={`bt_fee_${i}`} error={state.fieldErrors?.[`fee_${i}`]}>
                  <Input
                    id={`bt_fee_${i}`}
                    name={`bt_fee_${i}`}
                    type="number"
                    step="0.01"
                    min="0"
                    inputMode="decimal"
                    placeholder="4.99"
                    value={rs.fee}
                    disabled={!rs.enabled}
                    onChange={(e) => setRow(row.id, { fee: e.target.value })}
                  />
                </Field>
              </div>
            );
          })}
        </FormSection>
      ))}

      {state.error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      )}
      {state.saved && (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          Groupon fees saved.
        </p>
      )}

      <Button type="submit" disabled={isPending}>
        {isPending ? "Saving..." : "Save Groupon fees"}
      </Button>
    </form>
  );
}
