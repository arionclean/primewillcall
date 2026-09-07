"use client";

import { useActionState, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { FormSection } from "@/components/ui/form-section";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";

import {
  createEmployeeAction,
  deleteEmployeeAction,
  setEmployeeActiveAction,
  setEmployeePinAction,
  type EmployeeActionState,
} from "./actions";

export type EmployeeRow = {
  id: string;
  name: string;
  isActive: boolean;
  lastSeenAt: string | null;
  lastSeenKiosk: string | null;
};

type Props = {
  employees: EmployeeRow[];
  loadError: boolean;
};

const INITIAL: EmployeeActionState = {};

const whenFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function lastSeen(e: EmployeeRow): string {
  if (!e.lastSeenAt) return "Never signed in";
  return `${whenFmt.format(new Date(e.lastSeenAt))}${e.lastSeenKiosk ? ` on ${e.lastSeenKiosk}` : ""}`;
}

/** The people and the add form. The activity log below is its own component. */
export function EmployeesView({ employees, loadError }: Props) {
  const [createState, createAction] = useActionState(createEmployeeAction, INITIAL);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Employees</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The people who use the tablets, at any business. Each one has a 4-digit PIN;
          every sale, check-in and card action on a tablet is recorded under whoever typed it.
        </p>
      </header>

      {loadError && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Could not load the employees. Refresh the page and try again.
        </p>
      )}

      {/* People */}
      <section>
        {employees.length === 0 ? (
          <p className="rounded-md border border-dashed bg-muted/30 px-3 py-3 text-sm text-muted-foreground">
            No employees yet. Add the first one below.
          </p>
        ) : (
          <ul className="space-y-2">
            {employees.map((e) => (
              <EmployeeCard key={e.id} employee={e} />
            ))}
          </ul>
        )}
      </section>

      {/* Add */}
      <form action={createAction} className="space-y-4">
        <FormSection
          title="Add employee"
          description="Give them a name and a 4-digit PIN. They type the PIN on any tablet to start working."
          contentClassName="grid gap-4 sm:grid-cols-3"
        >
          <Field label="Name" htmlFor="emp-name" error={createState.fieldErrors?.name}>
            <Input id="emp-name" name="name" autoComplete="off" placeholder="Maria" required />
          </Field>
          <Field label="PIN" htmlFor="emp-pin" error={createState.fieldErrors?.pin} hint="4 digits">
            <Input id="emp-pin" name="pin" type="password" inputMode="numeric" pattern="\d{4}" maxLength={4} autoComplete="off" required />
          </Field>
          <Field label="Confirm PIN" htmlFor="emp-pin2">
            <Input id="emp-pin2" name="pin_confirm" type="password" inputMode="numeric" pattern="\d{4}" maxLength={4} autoComplete="off" required />
          </Field>
          <div className="sm:col-span-3 flex items-center gap-3">
            <SubmitButton>Add employee</SubmitButton>
            {createState.saved && <span className="text-sm text-muted-foreground">Added.</span>}
            {createState.error && <span className="text-sm text-destructive">{createState.error}</span>}
          </div>
        </FormSection>
      </form>
    </div>
  );
}

function EmployeeCard({ employee }: { employee: EmployeeRow }) {
  const [changingPin, setChangingPin] = useState(false);
  const [pinState, pinAction] = useActionState(setEmployeePinAction, INITIAL);

  return (
    <li>
      <Card>
        <CardContent className="space-y-3 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{employee.name}</span>
                <Badge tone={employee.isActive ? "success" : "neutral"}>{employee.isActive ? "Active" : "Inactive"}</Badge>
              </div>
              <p className="text-xs text-muted-foreground">{lastSeen(employee)}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a href={`?employee=${employee.id}#activity`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                Activity
              </a>
              <Button type="button" variant="outline" size="sm" onClick={() => setChangingPin((v) => !v)}>
                {changingPin ? "Cancel" : "Change PIN"}
              </Button>
              <form action={setEmployeeActiveAction}>
                <input type="hidden" name="employee_id" value={employee.id} />
                <input type="hidden" name="active" value={employee.isActive ? "0" : "1"} />
                <SubmitButton variant="outline" size="sm">{employee.isActive ? "Deactivate" : "Reactivate"}</SubmitButton>
              </form>
              <form
                action={deleteEmployeeAction}
                onSubmit={(e) => {
                  if (!window.confirm(`Remove ${employee.name}? Their past activity keeps the name.`)) e.preventDefault();
                }}
              >
                <input type="hidden" name="employee_id" value={employee.id} />
                <SubmitButton variant="ghost" size="sm" className="text-destructive">Remove</SubmitButton>
              </form>
            </div>
          </div>

          {changingPin && (
            <form action={pinAction} className="grid gap-3 border-t pt-3 sm:grid-cols-3">
              <input type="hidden" name="employee_id" value={employee.id} />
              <Field label="New PIN" htmlFor={`pin-${employee.id}`} error={pinState.fieldErrors?.pin}>
                <Input id={`pin-${employee.id}`} name="pin" type="password" inputMode="numeric" pattern="\d{4}" maxLength={4} autoComplete="off" required />
              </Field>
              <Field label="Confirm" htmlFor={`pin2-${employee.id}`}>
                <Input id={`pin2-${employee.id}`} name="pin_confirm" type="password" inputMode="numeric" pattern="\d{4}" maxLength={4} autoComplete="off" required />
              </Field>
              <div className="flex items-end gap-3">
                <SubmitButton size="sm">Save PIN</SubmitButton>
                {pinState.saved && <span className="text-sm text-muted-foreground">Saved.</span>}
                {pinState.error && <span className="text-sm text-destructive">{pinState.error}</span>}
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </li>
  );
}
