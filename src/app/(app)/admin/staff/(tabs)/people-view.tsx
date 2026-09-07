"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";

import {
  createEmployeeAction,
  deleteEmployeeAction,
  setEmployeeActiveAction,
  setEmployeePinAction,
  type PersonActionState,
} from "./actions";
import { personValue } from "./activity-shared";

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

const INITIAL: PersonActionState = {};

const whenFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function lastSeen(e: EmployeeRow): string {
  if (!e.lastSeenAt) return "Never signed in";
  const where = e.lastSeenKiosk === "web" ? "on the web" : e.lastSeenKiosk ? `on ${e.lastSeenKiosk}` : "";
  return `${whenFmt.format(new Date(e.lastSeenAt))} ${where}`.trim();
}

/** The people who type a PIN, and the Add employee dialog. */
export function PeopleView({ employees, loadError }: Props) {
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <Button type="button" onClick={() => setAdding(true)}>
          + Add employee
        </Button>
      </div>

      {loadError && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Could not load the employees. Refresh the page and try again.
        </p>
      )}

      {employees.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <p className="text-sm text-muted-foreground">No employees yet.</p>
            <Button type="button" onClick={() => setAdding(true)}>
              + Add your first employee
            </Button>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {employees.map((e) => (
            <EmployeeCard key={e.id} employee={e} />
          ))}
        </ul>
      )}

      {adding && <AddEmployeeDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

/** A small dialog: name and PIN. Closes itself once the person is saved. */
function AddEmployeeDialog({ onClose }: { onClose: () => void }) {
  const [state, action] = useActionState(createEmployeeAction, INITIAL);

  useEffect(() => {
    if (state.saved) onClose();
  }, [state.saved, onClose]);

  return (
    <Dialog
      title="Add employee"
      description="A name and a 4-digit PIN. They type the PIN on any tablet or shared computer."
      onClose={onClose}
    >
      <form action={action} className="space-y-4">
        <Field label="Name" htmlFor="emp-name" error={state.fieldErrors?.name}>
          <Input id="emp-name" name="name" autoComplete="off" placeholder="Maria" required autoFocus />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="PIN" htmlFor="emp-pin" error={state.fieldErrors?.pin} hint="4 digits">
            <Input id="emp-pin" name="pin" type="password" inputMode="numeric" pattern="\d{4}" maxLength={4} autoComplete="off" required />
          </Field>
          <Field label="Confirm PIN" htmlFor="emp-pin2">
            <Input id="emp-pin2" name="pin_confirm" type="password" inputMode="numeric" pattern="\d{4}" maxLength={4} autoComplete="off" required />
          </Field>
        </div>
        {state.error && <p className="text-sm text-destructive">{state.error}</p>}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <SubmitButton>Add employee</SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}

function EmployeeCard({ employee }: { employee: EmployeeRow }) {
  const [changingPin, setChangingPin] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [pinState, pinAction] = useActionState(setEmployeePinAction, INITIAL);
  const activityHref = `/admin/staff/activity?person=${encodeURIComponent(personValue(employee.id, null))}`;

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
              <Link href={activityHref} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                Activity
              </Link>
              <Button type="button" variant="outline" size="sm" onClick={() => setChangingPin((v) => !v)}>
                {changingPin ? "Cancel" : "Change PIN"}
              </Button>
              <form action={setEmployeeActiveAction}>
                <input type="hidden" name="employee_id" value={employee.id} />
                <input type="hidden" name="active" value={employee.isActive ? "0" : "1"} />
                <SubmitButton variant="outline" size="sm">{employee.isActive ? "Deactivate" : "Reactivate"}</SubmitButton>
              </form>
              {/* The browser's own confirm box is blocked in some webviews, so the
                  question is asked in the page. */}
              <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirmingRemove(true)}>
                Remove
              </Button>
            </div>
          </div>

          {confirmingRemove && (
            <Dialog
              title={`Remove ${employee.name}?`}
              description="Their PIN stops working. Past activity keeps the name."
              onClose={() => setConfirmingRemove(false)}
            >
              <form action={deleteEmployeeAction} className="flex items-center justify-end gap-2">
                <input type="hidden" name="employee_id" value={employee.id} />
                <Button type="button" variant="ghost" onClick={() => setConfirmingRemove(false)}>
                  Keep
                </Button>
                <SubmitButton variant="destructive">Remove</SubmitButton>
              </form>
            </Dialog>
          )}

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
