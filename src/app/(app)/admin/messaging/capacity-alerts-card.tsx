"use client";

import { useActionState, useState, useTransition } from "react";
import { ChevronDown, Plus, Users, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PhoneInput } from "@/components/ui/phone-input";
import { SubmitButton } from "@/components/ui/submit-button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import {
  deleteCapacityAlertAction,
  saveCapacityAlertAction,
  setSlotAlertsEnabledAction,
  type CapacityAlertState,
} from "./capacity-actions";

export type CapacityProduct = { id: string; name: string };

export type CapacityAlert = {
  id: string;
  name: string;
  thresholdPax: number;
  tourIds: string[];
  phones: string[];
  emails: string[];
};

const INITIAL: CapacityAlertState = {};

/**
 * Capacity alerts: when a departure reaches a set number of guests, the people
 * who run it get a text and an email.
 *
 * Not one of the automations above it. Those send to the guest, one message per
 * booking. This watches a whole departure, summed across every product the
 * alert holds and every business selling them, so it has its own settings and
 * its own switch. Products are grouped because two of them can share a vehicle.
 */
export function CapacityAlertsCard({
  enabled,
  alerts,
  products,
}: {
  enabled: boolean;
  alerts: CapacityAlert[];
  products: CapacityProduct[];
}) {
  const [on, setOn] = useState(enabled);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next = !on;
    setOn(next);
    setError(null);
    startTransition(async () => {
      const result = await setSlotAlertsEnabledAction(next);
      if (result.error) {
        setOn(!next); // roll back
        setError(result.error);
      }
    });
  }

  const takenTourIds = new Set(alerts.flatMap((alert) => alert.tourIds));

  return (
    <section className="mt-10">
      <div className="mb-3 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="-mx-2 flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-1 text-left transition-colors hover:bg-muted/50"
        >
          <span className="min-w-0 flex-1">
            {/* span, not h2: a button may only contain phrasing content. */}
            <span
              role="heading"
              aria-level={2}
              className="flex items-center gap-2 text-sm font-semibold"
            >
              Capacity alerts
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                <Users className="size-3" aria-hidden />
                {alerts.length === 0 ? "None set" : `${alerts.length} set`}
              </span>
            </span>
            <span className="mt-1 block text-sm text-muted-foreground">
              Tells your team when a departure is filling up.
            </span>
          </span>
          <ChevronDown
            size={16}
            className="shrink-0 text-muted-foreground"
            style={{
              transform: open ? "rotate(180deg)" : "none",
              transition: "transform 150ms ease",
            }}
            aria-hidden
          />
        </button>

        <div className="shrink-0">
          <Switch checked={on} onChange={toggle} disabled={pending} label="Capacity alerts on" />
        </div>
      </div>

      {error ? (
        <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}

      {on && alerts.length === 0 ? (
        <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          On, but no alert is set up yet, so nothing will send. Open this section
          and add one.
        </p>
      ) : null}

      {open ? (
        <div className="space-y-2">
          <ul className="space-y-2">
            {alerts.map((alert) => (
              <AlertRow
                key={alert.id}
                alert={alert}
                products={products}
                takenTourIds={takenTourIds}
              />
            ))}
          </ul>

          {adding ? (
            <div className="rounded-lg border bg-card">
              <AlertForm
                products={products}
                takenTourIds={takenTourIds}
                onDone={() => setAdding(false)}
              />
            </div>
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={() => setAdding(true)}>
              <Plus className="size-4" aria-hidden />
              Add an alert
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}

/** One saved alert: a summary line that opens into its settings. */
function AlertRow({
  alert,
  products,
  takenTourIds,
}: {
  alert: CapacityAlert;
  products: CapacityProduct[];
  takenTourIds: Set<string>;
}) {
  const [open, setOpen] = useState(false);

  const watched = products
    .filter((product) => alert.tourIds.includes(product.id))
    .map((product) => product.name)
    .join(", ");

  return (
    <li className="rounded-lg border bg-card">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-3 py-3 text-left"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{alert.name}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            Alerts at {alert.thresholdPax} guests. {watched || "No products picked."}
          </span>
        </span>
        <ChevronDown
          size={16}
          className="shrink-0 text-muted-foreground"
          style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 150ms ease" }}
          aria-hidden
        />
      </button>

      {open ? (
        <AlertForm alert={alert} products={products} takenTourIds={takenTourIds} />
      ) : null}
    </li>
  );
}

/** The settings for one alert, new or existing. */
function AlertForm({
  alert,
  products,
  takenTourIds,
  onDone,
}: {
  alert?: CapacityAlert;
  products: CapacityProduct[];
  takenTourIds: Set<string>;
  onDone?: () => void;
}) {
  const [state, formAction] = useActionState(saveCapacityAlertAction, INITIAL);
  const [phones, setPhones] = useState<Row[]>(() => toRows(alert?.phones ?? []));
  const [emails, setEmails] = useState<Row[]>(() => toRows(alert?.emails ?? []));
  const fieldId = alert?.id ?? "new";

  return (
    <div className="space-y-4 border-t px-3 py-4">
      <form action={formAction} className="space-y-4">
        {alert ? <input type="hidden" name="id" value={alert.id} /> : null}

        <div className="space-y-2">
          <label htmlFor={`name-${fieldId}`} className="text-sm font-medium">
            Name
          </label>
          <Input
            id={`name-${fieldId}`}
            name="name"
            defaultValue={alert?.name ?? ""}
            placeholder="Miami City Tour"
            maxLength={80}
          />
        </div>

        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">Products to watch</legend>
          <div className="space-y-1.5">
            {products.map((product) => {
              const mine = alert?.tourIds.includes(product.id) ?? false;
              const takenByAnother = takenTourIds.has(product.id) && !mine;
              return (
                <label
                  key={product.id}
                  className={cn(
                    "flex items-center gap-2 text-sm",
                    takenByAnother && "text-muted-foreground",
                  )}
                >
                  <input
                    type="checkbox"
                    name="tour_id"
                    value={product.id}
                    defaultChecked={mine}
                    disabled={takenByAnother}
                    className="size-4 rounded border-input"
                  />
                  <span className="min-w-0 truncate">{product.name}</span>
                  {takenByAnother ? (
                    <span className="text-xs">(another alert watches it)</span>
                  ) : null}
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="space-y-2">
          <label htmlFor={`threshold-${fieldId}`} className="text-sm font-medium">
            Alert at
          </label>
          <div className="flex items-center gap-2">
            <Input
              id={`threshold-${fieldId}`}
              name="threshold_pax"
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              defaultValue={alert?.thresholdPax ?? ""}
              className="w-28"
            />
            <span className="text-sm text-muted-foreground">
              guests booked on one departure
            </span>
          </div>
        </div>

        <RecipientList
          legend="Text these numbers"
          rows={phones}
          onChange={setPhones}
          addLabel="Add a number"
          render={(row) => (
            <PhoneInput name="phone" defaultValue={row.value} placeholder="(305) 555 1234" />
          )}
        />

        <RecipientList
          legend="Email these addresses"
          rows={emails}
          onChange={setEmails}
          addLabel="Add an address"
          render={(row) => (
            <Input
              name="email"
              type="email"
              defaultValue={row.value}
              placeholder="reservations@example.com"
            />
          )}
        />

        {state.error ? (
          <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {state.error}
          </p>
        ) : null}
        {state.saved ? <p className="text-sm text-emerald-700">Saved.</p> : null}

        <div className="flex items-center gap-2">
          <SubmitButton>Save</SubmitButton>
          {onDone ? (
            <Button type="button" variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          ) : null}
        </div>
      </form>

      {alert ? (
        <form action={deleteCapacityAlertAction} className="border-t pt-3">
          <input type="hidden" name="id" value={alert.id} />
          <SubmitButton variant="destructive">Remove this alert</SubmitButton>
        </form>
      ) : null}
    </div>
  );
}

/** One recipient input. The key is minted once so a removal cannot shift the
 * value of the row below it into the row above. */
type Row = { key: string; value: string };

let rowSeq = 0;
function newRow(value = ""): Row {
  rowSeq += 1;
  return { key: `r${rowSeq}`, value };
}

function toRows(values: string[]): Row[] {
  return values.length > 0 ? values.map((value) => newRow(value)) : [newRow()];
}

/**
 * A short list of recipients that grows a row at a time. The inputs are
 * uncontrolled and post under one repeated name, so the server reads them with
 * getAll and this component only tracks which rows exist.
 */
function RecipientList({
  legend,
  rows,
  onChange,
  addLabel,
  render,
}: {
  legend: string;
  rows: Row[];
  onChange: (next: Row[]) => void;
  addLabel: string;
  render: (row: Row) => React.ReactNode;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      {rows.map((row) => (
        <div key={row.key} className="flex items-center gap-2">
          <div className="min-w-0 flex-1">{render(row)}</div>
          <button
            type="button"
            onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
            aria-label="Remove"
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground",
              rows.length === 1 && "invisible",
            )}
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...rows, newRow()])}>
        <Plus className="size-4" aria-hidden />
        {addLabel}
      </Button>
    </fieldset>
  );
}
