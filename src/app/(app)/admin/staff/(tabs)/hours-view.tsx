"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { Fragment, useActionState, useEffect, useMemo, useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { downloadCsv } from "@/lib/csv";
import { useLiveRefresh } from "@/lib/realtime/use-live-refresh";
import { cn } from "@/lib/utils";

import {
  confirmShiftAction,
  deleteShiftAction,
  updateShiftAction,
  type HoursActionState,
} from "./hours-actions";
import { decimalHours, formatMinutes } from "./hours-range";
import { RangeBar } from "./range-bar";

export type ShiftRow = {
  id: string;
  employeeId: string | null;
  name: string;
  inAt: string;
  outAt: string | null;
  inKiosk: string | null;
  outKiosk: string | null;
  /** Signed link to the clock-in photo; null when the tablet took none. */
  photoUrl: string | null;
  autoClosed: boolean;
  reviewed: boolean;
  edited: boolean;
};

export type PersonTotal = {
  employeeId: string | null;
  name: string;
  shifts: number;
  days: number;
  minutes: number;
  open: number;
  needsReview: number;
};

type Props = {
  totals: PersonTotal[];
  /** Shifts waiting on the owner anywhere in the record, not just in this range. */
  needsReview: { count: number; from: string | null; to: string };
  shifts: ShiftRow[];
  filters: { from: string; to: string };
  truncated: boolean;
  loadError: boolean;
};

const NY_TZ = "America/New_York";
const INITIAL: HoursActionState = {};

const dayLabelFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: NY_TZ,
  weekday: "short",
  month: "short",
  day: "numeric",
});
const timeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: NY_TZ,
  hour: "numeric",
  minute: "2-digit",
});
/** YYYY-MM-DD and HH:MM in business time, the shapes the date and time inputs want. */
const dayValueFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: NY_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const timeValueFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: NY_TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  hourCycle: "h23",
});

const dayLabel = (iso: string) => dayLabelFmt.format(new Date(iso));
const timeLabel = (iso: string) => timeFmt.format(new Date(iso));
const dayValue = (iso: string) => dayValueFmt.format(new Date(iso));
const timeValue = (iso: string) => timeValueFmt.format(new Date(iso));

/** Minutes worked; an open shift counts up to `now`, the same way the totals do. */
function shiftMinutes(s: ShiftRow, now: number): number {
  const end = s.outAt ? new Date(s.outAt).getTime() : now;
  return Math.max(0, Math.round((end - new Date(s.inAt).getTime()) / 60000));
}

/** One key per person, falling back to the name for somebody since removed. */
function personKey(employeeId: string | null, name: string): string {
  return employeeId ?? `name:${name}`;
}

function kioskLabel(slug: string | null): string {
  if (!slug) return "";
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

/** The clock-in photo, or the person's initial when there is none. */
function PersonPhoto({ shift, size = "size-10" }: { shift: ShiftRow; size?: string }) {
  if (!shift.photoUrl) {
    return (
      <span
        className={`flex ${size} shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-muted-foreground`}
        aria-hidden
      >
        {shift.name.trim().charAt(0).toUpperCase() || "?"}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={shift.photoUrl}
      alt={`${shift.name} at clock in`}
      className={`${size} shrink-0 rounded-full border object-cover`}
    />
  );
}

export function HoursView({
  totals,
  needsReview,
  shifts,
  filters,
  truncated,
  loadError,
}: Props) {
  const router = useRouter();
  const from = filters.from;
  const to = filters.to;
  // Clicking a person opens their shifts underneath, with the exact times.
  const [openPerson, setOpenPerson] = useState<string | null>(null);
  const [editing, setEditing] = useState<ShiftRow | null>(null);
  const [photo, setPhoto] = useState<ShiftRow | null>(null);
  const [, startTransition] = useTransition();

  // Someone clocking in or out anywhere should show up here without a reload.
  useLiveRefresh("time-clock", [{ table: "time_clock_shifts" }]);

  // An open shift is a running clock, so the minutes on screen have to move.
  const anyRunning = shifts.some((s) => !s.outAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [anyRunning]);

  function setRange(nextFrom: string, nextTo: string) {
    startTransition(() => router.push(`/admin/staff/hours?from=${nextFrom}&to=${nextTo}`));
  }

  const totalMinutes = useMemo(
    () => totals.reduce((sum, t) => sum + t.minutes, 0),
    [totals],
  );

  function exportCsv() {
    downloadCsv(
      from === to ? `hours-${from}.csv` : `hours-${from}_to_${to}.csv`,
      ["Date", "Person", "Clock in", "Clock out", "Hours", "Tablet", "Note"],
      shifts.map((s) => [
        dayValue(s.inAt),
        s.name,
        timeLabel(s.inAt),
        s.outAt ? timeLabel(s.outAt) : "still on the clock",
        decimalHours(shiftMinutes(s, now)),
        kioskLabel(s.inKiosk),
        s.autoClosed && !s.reviewed ? "forgot to clock out" : s.edited ? "edited" : "",
      ]),
    );
  }

  return (
    <div className="space-y-6">
      {loadError && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Could not load the hours. Refresh the page and try again.
        </p>
      )}

      <RangeBar from={from} to={to} onRange={setRange}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={exportCsv}
          disabled={shifts.length === 0}
          className="ml-auto"
        >
          Export CSV
        </Button>
      </RangeBar>

      {/* ── Hours per person ─────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs font-medium text-muted-foreground">
                <th className="px-4 py-2.5">Person</th>
                <th className="px-4 py-2.5">Days</th>
                <th className="px-4 py-2.5">Shifts</th>
                <th className="px-4 py-2.5 text-right">Hours</th>
              </tr>
            </thead>
            <tbody>
              {totals.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                    Nobody clocked in during this range.
                  </td>
                </tr>
              ) : (
                totals.map((t) => {
                  const key = personKey(t.employeeId, t.name);
                  const open = openPerson === key;
                  const theirs = shifts.filter((s) => personKey(s.employeeId, s.name) === key);
                  return (
                    <Fragment key={key}>
                      <tr
                        className={cn(
                          "cursor-pointer border-b transition last:border-0 hover:bg-muted/40",
                          open && "bg-muted/40",
                        )}
                        onClick={() => setOpenPerson(open ? null : key)}
                        aria-expanded={open}
                      >
                        <td className="px-4 py-2.5">
                          {open ? (
                            <ChevronDown className="mr-1.5 inline size-3.5 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="mr-1.5 inline size-3.5 text-muted-foreground" />
                          )}
                          <span className="font-medium">{t.name}</span>
                          {t.open > 0 && (
                            <Badge tone="success" className="ml-2">
                              On the clock
                            </Badge>
                          )}
                          {t.needsReview > 0 && (
                            <Badge tone="warning" className="ml-2">
                              {t.needsReview} to review
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">{t.days}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">{t.shifts}</td>
                        <td className="px-4 py-2.5 text-right font-medium tabular-nums">
                          {formatMinutes(t.minutes)}
                        </td>
                      </tr>
                      {open && (
                        <tr className="border-b bg-muted/20 last:border-0">
                          <td colSpan={4} className="px-4 py-3">
                            {theirs.length === 0 ? (
                              <p className="text-sm text-muted-foreground">
                                No shifts in this range.
                              </p>
                            ) : (
                              <ul className="space-y-1.5">
                                {theirs.map((s) => (
                                  <li key={s.id} className="flex flex-wrap items-center gap-3 text-sm">
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (s.photoUrl) setPhoto(s);
                                      }}
                                      className="rounded-full"
                                      aria-label={
                                        s.photoUrl ? `See ${s.name}'s clock-in photo` : s.name
                                      }
                                    >
                                      <PersonPhoto shift={s} size="size-8" />
                                    </button>
                                    {/* Fixed widths, so the times and tablets line up down the column. */}
                                    <span className="w-24 shrink-0 text-muted-foreground">
                                      {dayLabel(s.inAt)}
                                    </span>
                                    <span className="w-[4.5rem] shrink-0 text-right tabular-nums">
                                      {timeLabel(s.inAt)}
                                    </span>
                                    <span className="w-5 shrink-0 text-center text-muted-foreground">to</span>
                                    <span className="w-[4.5rem] shrink-0 tabular-nums">
                                      {s.outAt ? (
                                        timeLabel(s.outAt)
                                      ) : (
                                        <span className="text-muted-foreground">now</span>
                                      )}
                                    </span>
                                    <span className="w-16 shrink-0 text-xs text-muted-foreground">
                                      {s.inKiosk ? kioskLabel(s.inKiosk) : ""}
                                      {s.outKiosk && s.outKiosk !== s.inKiosk
                                        ? ` to ${kioskLabel(s.outKiosk)}`
                                        : ""}
                                    </span>
                                    {s.autoClosed && !s.reviewed && (
                                      <Badge tone="warning">Forgot to clock out</Badge>
                                    )}
                                    {s.edited && (
                                      <span className="text-xs text-muted-foreground">edited</span>
                                    )}
                                    <span className="ml-auto w-16 shrink-0 text-right font-medium tabular-nums">
                                      {formatMinutes(shiftMinutes(s, now))}
                                    </span>
                                    {s.autoClosed && !s.reviewed && (
                                      <form action={confirmShiftAction} onClick={(e) => e.stopPropagation()}>
                                        <input type="hidden" name="shift_id" value={s.id} />
                                        <SubmitButton variant="outline" size="sm">
                                          Looks right
                                        </SubmitButton>
                                      </form>
                                    )}
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setEditing(s);
                                      }}
                                    >
                                      Edit
                                    </Button>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
            {totals.length > 1 && (
              <tfoot>
                <tr className="border-t bg-muted/40">
                  <td className="px-4 py-2.5 font-medium" colSpan={3}>
                    Everyone
                  </td>
                  <td className="px-4 py-2.5 text-right font-semibold tabular-nums">
                    {formatMinutes(totalMinutes)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </CardContent>
      </Card>

      {truncated && (
        <p className="text-sm text-muted-foreground">
          Showing the most recent shifts only. Pick a shorter range to see the rest.
        </p>
      )}

      {needsReview.count > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <span>
            {needsReview.count === 1
              ? "One shift needs a look"
              : `${needsReview.count} shifts need a look`}
            : somebody forgot to clock out.
          </span>
          {needsReview.from && (
            <button
              type="button"
              onClick={() => setRange(needsReview.from as string, needsReview.to)}
              className="ml-auto rounded-md border border-amber-300 bg-background px-2.5 py-1 text-xs font-medium text-amber-900 transition hover:bg-amber-100"
            >
              Show them
            </button>
          )}
        </div>
      )}

      {editing && <EditShiftDialog shift={editing} onClose={() => setEditing(null)} />}
      {photo?.photoUrl && (
        <Dialog title={`${photo.name} at ${timeLabel(photo.inAt)}`} onClose={() => setPhoto(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photo.photoUrl}
            alt={`${photo.name} at clock in`}
            className="max-h-[60vh] w-full rounded-lg border object-contain"
          />
        </Dialog>
      )}
    </div>
  );
}

/** Fix the times of one shift, or take it off the record. */
function EditShiftDialog({ shift, onClose }: { shift: ShiftRow; onClose: () => void }) {
  const [state, action] = useActionState(updateShiftAction, INITIAL);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  useEffect(() => {
    if (state.saved) onClose();
  }, [state.saved, onClose]);

  return (
    <Dialog
      title={`${shift.name}, ${dayLabel(shift.inAt)}`}
      description={
        shift.autoClosed
          ? "Closed overnight because nobody clocked out. Set the real times, or leave them and save."
          : "Change the times this shift started and ended."
      }
      onClose={onClose}
    >
      <form action={action} className="space-y-4">
        <input type="hidden" name="shift_id" value={shift.id} />
        <Field label="Date" htmlFor={`day-${shift.id}`} error={state.fieldErrors?.day}>
          <Input id={`day-${shift.id}`} name="day" type="date" defaultValue={dayValue(shift.inAt)} required />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Clocked in" htmlFor={`in-${shift.id}`} error={state.fieldErrors?.in_time}>
            <Input
              id={`in-${shift.id}`}
              name="in_time"
              type="time"
              defaultValue={timeValue(shift.inAt)}
              required
            />
          </Field>
          <Field
            label="Clocked out"
            htmlFor={`out-${shift.id}`}
            error={state.fieldErrors?.out_time}
            hint={shift.outAt ? "Leave empty to put them back on the clock" : "Empty while they are still working"}
          >
            <Input
              id={`out-${shift.id}`}
              name="out_time"
              type="time"
              defaultValue={shift.outAt ? timeValue(shift.outAt) : ""}
            />
          </Field>
        </div>
        {state.error && <p className="text-sm text-destructive">{state.error}</p>}
        <div className="flex items-center justify-between gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive"
            onClick={() => setConfirmingRemove(true)}
          >
            Remove shift
          </Button>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <SubmitButton>Save</SubmitButton>
          </div>
        </div>
      </form>

      {confirmingRemove && (
        <Dialog
          title="Remove this shift?"
          description="The hours go with it. Use this for a punch that should never have happened."
          onClose={() => setConfirmingRemove(false)}
        >
          <form action={deleteShiftAction} className="flex items-center justify-end gap-2">
            <input type="hidden" name="shift_id" value={shift.id} />
            <Button type="button" variant="ghost" onClick={() => setConfirmingRemove(false)}>
              Keep
            </Button>
            <SubmitButton variant="destructive">Remove</SubmitButton>
          </form>
        </Dialog>
      )}
    </Dialog>
  );
}
