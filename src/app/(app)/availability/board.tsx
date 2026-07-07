"use client";

import { useMemo, useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DateField } from "@/components/ui/date-field";
import { cn } from "@/lib/utils";

import {
  setDayAvailabilityAction,
  setSlotAvailabilityAction,
} from "./actions";

export type TourDay = {
  tourId: string;
  name: string;
  slots: { startTime: string; label: string; closed: boolean }[];
};

/** YYYY-MM-DD plus n days (plain-date math, no timezone involved). */
function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** "2026-07-07" -> "Tuesday, July 7". UTC keeps the plain date from shifting. */
function dayHeading(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

type OptimisticUpdate = { keys: string[]; closed: boolean };

export function AvailabilityBoard({
  date,
  today,
  tours,
}: {
  date: string;
  today: string;
  tours: TourDay[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const closedFromProps = useMemo(() => {
    const set = new Set<string>();
    for (const t of tours) {
      for (const s of t.slots) {
        if (s.closed) set.add(`${t.tourId}|${s.startTime}`);
      }
    }
    return set;
  }, [tours]);

  // Chips flip instantly; when the server action revalidates, the optimistic
  // set resets to the fresh server data (or rolls back on error).
  const [closedSet, applyUpdate] = useOptimistic(
    closedFromProps,
    (state: Set<string>, u: OptimisticUpdate) => {
      const next = new Set(state);
      for (const k of u.keys) {
        if (u.closed) next.add(k);
        else next.delete(k);
      }
      return next;
    },
  );

  function goTo(nextDate: string) {
    router.push(`/availability?date=${nextDate}`);
  }

  function toggleSlot(tourId: string, startTime: string, closed: boolean) {
    setError(null);
    startTransition(async () => {
      applyUpdate({ keys: [`${tourId}|${startTime}`], closed });
      const res = await setSlotAvailabilityAction({
        tourId,
        date,
        startTime,
        closed,
      });
      if (res.error) setError(res.error);
    });
  }

  function toggleDay(tour: TourDay, closed: boolean) {
    setError(null);
    startTransition(async () => {
      applyUpdate({
        keys: tour.slots.map((s) => `${tour.tourId}|${s.startTime}`),
        closed,
      });
      const res = await setDayAvailabilityAction({
        tourId: tour.tourId,
        date,
        closed,
      });
      if (res.error) setError(res.error);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          aria-label="Previous day"
          disabled={date <= today}
          onClick={() => goTo(addDays(date, -1))}
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="Next day"
          onClick={() => goTo(addDays(date, 1))}
        >
          <ChevronRight />
        </Button>
        <DateField
          aria-label="Date"
          className="w-44"
          value={date}
          min={today}
          onChange={(e) => {
            if (e.target.value) goTo(e.target.value);
          }}
        />
        {date !== today && (
          <Button variant="ghost" size="sm" onClick={() => goTo(today)}>
            Back to today
          </Button>
        )}
        <span className="ml-auto text-sm font-medium text-muted-foreground">
          {dayHeading(date)}
          {isPending && <span className="ml-2 text-xs">Saving...</span>}
        </span>
      </div>

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {tours.length === 0 ? (
        <Card>
          <CardContent className="text-sm text-muted-foreground">
            No active tours to manage yet.
          </CardContent>
        </Card>
      ) : (
        tours.map((tour) => {
          const openCount = tour.slots.filter(
            (s) => !closedSet.has(`${tour.tourId}|${s.startTime}`),
          ).length;
          const anyOpen = openCount > 0;
          return (
            <Card key={tour.tourId}>
              <CardHeader className="flex-row items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <CardTitle className="text-base">{tour.name}</CardTitle>
                  <CardDescription>
                    {tour.slots.length === 0
                      ? "No times configured"
                      : `${openCount} of ${tour.slots.length} times open`}
                  </CardDescription>
                </div>
                {tour.slots.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => toggleDay(tour, anyOpen)}
                  >
                    {anyOpen ? "Close the whole day" : "Reopen the whole day"}
                  </Button>
                )}
              </CardHeader>
              <CardContent className="pt-4">
                {tour.slots.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    This tour has no booking times set up. The owner can add
                    them under Tours.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {tour.slots.map((s) => {
                      const closed = closedSet.has(
                        `${tour.tourId}|${s.startTime}`,
                      );
                      return (
                        <button
                          key={s.startTime}
                          type="button"
                          aria-pressed={!closed}
                          onClick={() =>
                            toggleSlot(tour.tourId, s.startTime, !closed)
                          }
                          className={cn(
                            "flex min-w-24 flex-col items-center rounded-lg border px-3 py-2 text-sm transition outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                            closed
                              ? "border-red-200 bg-red-50 text-red-700 hover:border-red-300"
                              : "border-emerald-200 bg-emerald-50 text-emerald-900 hover:border-emerald-300",
                          )}
                        >
                          <span className="font-medium">{s.label}</span>
                          <span className="text-xs opacity-80">
                            {closed ? "Closed" : "Open"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}
