"use client";

import { useActionState, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { FormSection } from "@/components/ui/form-section";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SubmitButton } from "@/components/ui/submit-button";
import { eventDetail, eventLabel, PERSON_EVENTS } from "@/lib/kiosk/events";
import { useLiveRefresh } from "@/lib/realtime/use-live-refresh";

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
export type KioskOption = { id: string; slug: string; name: string };
export type ActivityRow = {
  id: number;
  at: string;
  event: string;
  level: string;
  ref: string | null;
  payload: Record<string, unknown> | null;
  kioskSlug: string | null;
  employeeId: string | null;
  employeeName: string | null;
  appBuild: string | null;
};

type Props = {
  employees: EmployeeRow[];
  kiosks: KioskOption[];
  activity: ActivityRow[];
  filters: { employee: string; day: string; kiosk: string };
  loadError: boolean;
};

const INITIAL: EmployeeActionState = {};

const timeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});
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

export function EmployeesView({ employees, kiosks, activity, filters, loadError }: Props) {
  // New events land within a second; the server re-renders with the same filters.
  useLiveRefresh("employees-activity", [{ table: "kiosk_events", event: "INSERT" }]);

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
          Could not load everything. Refresh the page and try again.
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

      {/* Activity */}
      <section className="space-y-3">
        <div className="px-1">
          <h2 className="text-lg font-semibold tracking-tight">Activity</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Everything the tablets recorded that day, newest first. Updates live.
          </p>
        </div>
        <Card>
          <CardContent className="space-y-4 py-5">
            <form method="get" className="grid gap-3 sm:grid-cols-4">
              <Field label="Day" htmlFor="act-day">
                <Input id="act-day" type="date" name="day" defaultValue={filters.day} />
              </Field>
              <Field label="Employee" htmlFor="act-emp">
                <Select id="act-emp" name="employee" defaultValue={filters.employee}>
                  <option value="">Everyone</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Tablet" htmlFor="act-kiosk">
                <Select id="act-kiosk" name="kiosk" defaultValue={filters.kiosk}>
                  <option value="">All tablets</option>
                  {kiosks.map((k) => (
                    <option key={k.id} value={k.slug}>
                      {k.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex items-end">
                <Button type="submit" variant="outline">
                  Show
                </Button>
              </div>
            </form>

            {activity.length === 0 ? (
              <p className="rounded-md border border-dashed bg-muted/30 px-3 py-3 text-sm text-muted-foreground">
                Nothing recorded for this selection.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-3 font-medium">Time</th>
                      <th className="py-2 pr-3 font-medium">Who</th>
                      <th className="py-2 pr-3 font-medium">Tablet</th>
                      <th className="py-2 pr-3 font-medium">What</th>
                      <th className="py-2 font-medium">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {activity.map((a) => {
                      const person = PERSON_EVENTS.has(a.event);
                      const detail = [eventDetail(a.event, a.payload), a.ref].filter(Boolean).join(" · ");
                      return (
                        <tr key={a.id} className={a.level === "error" ? "bg-red-50/60 dark:bg-red-950/20" : a.level === "warn" ? "bg-amber-50/60 dark:bg-amber-950/20" : ""}>
                          <td className="whitespace-nowrap py-2 pr-3 tabular-nums text-muted-foreground">{timeFmt.format(new Date(a.at))}</td>
                          <td className="whitespace-nowrap py-2 pr-3">
                            {a.employeeName ? (
                              <span className={person ? "font-medium" : ""}>{a.employeeName}</span>
                            ) : (
                              <span className="text-muted-foreground">Tablet</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap py-2 pr-3 text-muted-foreground">{a.kioskSlug ?? ""}</td>
                          <td className="py-2 pr-3">{eventLabel(a.event)}</td>
                          <td className="py-2 text-muted-foreground">{detail}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </section>
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
