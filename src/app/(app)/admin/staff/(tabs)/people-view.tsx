"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { FormSection } from "@/components/ui/form-section";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";

import {
  createPersonAction,
  deleteEmployeeAction,
  setEmployeeActiveAction,
  setPersonPinAction,
  type PersonActionState,
} from "./actions";
import { personValue } from "./activity-shared";

/** One person: their PIN (employee row) and/or their website login (staff row). */
export type PersonRow = {
  name: string;
  employeeId: string | null;
  staffId: string | null;
  email: string | null;
  role: "owner" | "business_manager" | null;
  businessName: string | null;
  isActive: boolean;
  lastSeenAt: string | null;
  lastSeenKiosk: string | null;
};

type Props = {
  people: PersonRow[];
  isOwner: boolean;
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

function lastSeen(p: PersonRow): string | null {
  if (!p.lastSeenAt) return null;
  const where = p.lastSeenKiosk === "web" ? "on the web" : p.lastSeenKiosk ? `on ${p.lastSeenKiosk}` : "";
  return `PIN used ${whenFmt.format(new Date(p.lastSeenAt))} ${where}`.trim();
}

const ROLE_LABEL = { owner: "Owner", business_manager: "Manager" } as const;

/** The people and the add form. The activity log below is its own component. */
export function PeopleView({ people, isOwner, loadError }: Props) {
  const [createState, createAction] = useActionState(createPersonAction, INITIAL);
  const [wantsLogin, setWantsLogin] = useState(false);

  return (
    <div className="space-y-8">
      <p className="text-sm text-muted-foreground">
        Everyone who works here, at any business. A PIN is what they type on a tablet or a
        shared computer; a website login is for people who manage things from their own
        computer. Some have one, some both. Every action is recorded under the person.
      </p>

      {loadError && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Could not load the people. Refresh the page and try again.
        </p>
      )}

      <section>
        {people.length === 0 ? (
          <p className="rounded-md border border-dashed bg-muted/30 px-3 py-3 text-sm text-muted-foreground">
            Nobody yet. Add the first person below.
          </p>
        ) : (
          <ul className="space-y-2">
            {people.map((p) => (
              <PersonCard key={p.employeeId ?? p.staffId ?? p.name} person={p} isOwner={isOwner} />
            ))}
          </ul>
        )}
      </section>

      <form action={createAction} className="space-y-4">
        <FormSection
          title="Add person"
          description="A name and a 4-digit PIN. They type the PIN on any tablet or shared computer to start working."
          contentClassName="grid gap-4 sm:grid-cols-3"
        >
          <Field label="Name" htmlFor="person-name" error={createState.fieldErrors?.name}>
            <Input id="person-name" name="name" autoComplete="off" placeholder="Maria" required />
          </Field>
          <Field
            label="PIN"
            htmlFor="person-pin"
            error={createState.fieldErrors?.pin}
            hint={wantsLogin ? "4 digits, or leave empty if they only use their own login" : "4 digits"}
          >
            <Input id="person-pin" name="pin" type="password" inputMode="numeric" pattern="\d{4}" maxLength={4} autoComplete="off" required={!wantsLogin} />
          </Field>
          <Field label="Confirm PIN" htmlFor="person-pin2">
            <Input id="person-pin2" name="pin_confirm" type="password" inputMode="numeric" pattern="\d{4}" maxLength={4} autoComplete="off" required={!wantsLogin} />
          </Field>
          {isOwner && (
            <label htmlFor="person-login" className="sm:col-span-3 flex items-center gap-2 text-sm">
              <input
                id="person-login"
                type="checkbox"
                name="login"
                value="1"
                checked={wantsLogin}
                onChange={(e) => setWantsLogin(e.target.checked)}
                className="size-4"
              />
              Also give them a website login (email and role come next)
            </label>
          )}
          <div className="sm:col-span-3 flex items-center gap-3">
            <SubmitButton>{wantsLogin ? "Add person and continue" : "Add person"}</SubmitButton>
            {createState.saved && <span className="text-sm text-muted-foreground">Added.</span>}
            {createState.error && <span className="text-sm text-destructive">{createState.error}</span>}
          </div>
        </FormSection>
      </form>
    </div>
  );
}

function PersonCard({ person, isOwner }: { person: PersonRow; isOwner: boolean }) {
  const [changingPin, setChangingPin] = useState(false);
  const [pinState, pinAction] = useActionState(setPersonPinAction, INITIAL);
  const hasPin = Boolean(person.employeeId);
  const details = [
    person.email,
    person.businessName,
    lastSeen(person),
  ].filter(Boolean);
  const activityHref = `?person=${encodeURIComponent(personValue(person.employeeId, person.staffId))}#activity`;

  return (
    <li>
      <Card>
        <CardContent className="space-y-3 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{person.name}</span>
                {person.role && <Badge tone={person.role === "owner" ? "primary" : "info"}>{ROLE_LABEL[person.role]}</Badge>}
                <Badge tone={hasPin ? "success" : "neutral"}>{hasPin ? "PIN" : "No PIN"}</Badge>
                {!person.isActive && <Badge tone="neutral">Inactive</Badge>}
              </div>
              {details.length > 0 && <p className="text-xs text-muted-foreground">{details.join(" · ")}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a href={activityHref} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                Activity
              </a>
              <Button type="button" variant="outline" size="sm" onClick={() => setChangingPin((v) => !v)}>
                {changingPin ? "Cancel" : hasPin ? "Change PIN" : "Set PIN"}
              </Button>
              {isOwner && person.staffId && (
                <Link href={`/admin/staff/${person.staffId}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Edit login
                </Link>
              )}
              {isOwner && !person.staffId && person.employeeId && (
                <Link
                  href={`/admin/staff/new?person=${person.employeeId}&name=${encodeURIComponent(person.name)}`}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  Add login
                </Link>
              )}
              {!person.staffId && person.employeeId && (
                <>
                  <form action={setEmployeeActiveAction}>
                    <input type="hidden" name="employee_id" value={person.employeeId} />
                    <input type="hidden" name="active" value={person.isActive ? "0" : "1"} />
                    <SubmitButton variant="outline" size="sm">{person.isActive ? "Deactivate" : "Reactivate"}</SubmitButton>
                  </form>
                  <form
                    action={deleteEmployeeAction}
                    onSubmit={(e) => {
                      if (!window.confirm(`Remove ${person.name}? Their past activity keeps the name.`)) e.preventDefault();
                    }}
                  >
                    <input type="hidden" name="employee_id" value={person.employeeId} />
                    <SubmitButton variant="ghost" size="sm" className="text-destructive">Remove</SubmitButton>
                  </form>
                </>
              )}
            </div>
          </div>

          {changingPin && (
            <form action={pinAction} className="grid gap-3 border-t pt-3 sm:grid-cols-3">
              {person.employeeId && <input type="hidden" name="employee_id" value={person.employeeId} />}
              {person.staffId && <input type="hidden" name="staff_id" value={person.staffId} />}
              <input type="hidden" name="name" value={person.name} />
              <Field label={hasPin ? "New PIN" : "PIN"} htmlFor={`pin-${person.employeeId ?? person.staffId}`} error={pinState.fieldErrors?.pin}>
                <Input id={`pin-${person.employeeId ?? person.staffId}`} name="pin" type="password" inputMode="numeric" pattern="\d{4}" maxLength={4} autoComplete="off" required />
              </Field>
              <Field label="Confirm" htmlFor={`pin2-${person.employeeId ?? person.staffId}`}>
                <Input id={`pin2-${person.employeeId ?? person.staffId}`} name="pin_confirm" type="password" inputMode="numeric" pattern="\d{4}" maxLength={4} autoComplete="off" required />
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
