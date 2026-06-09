import { Card } from "@/components/ui/card";
import type { TourTally } from "@/lib/dashboard/queries";

/**
 * Per-tour booking counts for the day, color-coded by tour. Pure data, no money.
 */
export function TourTallyStrip({ tallies }: { tallies: TourTally[] }) {
  if (tallies.length === 0) return null;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {tallies.map((t) => (
        <Card key={t.name} className="p-4">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-full"
              style={{ background: t.color ?? "var(--color-muted-foreground)" }}
            />
            <p className="truncate text-xs font-medium text-muted-foreground">
              {t.name}
            </p>
          </div>
          <p className="mt-1 text-2xl font-semibold tracking-tight">
            {t.guests}
          </p>
          <p className="text-xs text-muted-foreground">
            {t.count} booking{t.count === 1 ? "" : "s"}
          </p>
        </Card>
      ))}
    </div>
  );
}
