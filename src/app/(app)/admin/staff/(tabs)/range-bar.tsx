"use client";

import { useState } from "react";

import { DateField } from "@/components/ui/date-field";
import { SEGMENT, SEGMENT_ITEM, SEGMENT_OFF, SEGMENT_ON } from "@/components/ui/segment";
import { cn } from "@/lib/utils";

import { rangePresets } from "./hours-range";

/**
 * The date bar the Hours and Sales tabs share, the same one Analytics uses: a
 * calendar that picks a single day, the ranges in a segmented control, and
 * Custom to open a From / To pair. The field carries no label; the tab above
 * says what this is.
 *
 * It holds no dates of its own. The range lives in the URL and comes back in
 * as `from` / `to`; a pick goes out through `onRange`. A range that is neither a
 * preset nor a single day (a shared link, a banner's "Show them") opens the
 * From / To pair by itself. `children` sit at the end of the row.
 */
export function RangeBar({
  from,
  to,
  onRange,
  children,
}: {
  from: string;
  to: string;
  onRange: (from: string, to: string) => void;
  children?: React.ReactNode;
}) {
  const presets = rangePresets();
  const onPreset = presets.some((p) => p.from === from && p.to === to);
  // Custom stays open once chosen, until a preset or the calendar is used.
  const [customChosen, setCustomChosen] = useState(false);
  const custom = customChosen || (from !== to && !onPreset);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {custom ? (
        <div className="inline-flex items-center gap-1.5">
          <DateField
            value={from}
            onChange={(e) => e.target.value && onRange(e.target.value, to)}
            aria-label="From date"
            className="h-8 w-[9rem] text-xs"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <DateField
            value={to}
            onChange={(e) => e.target.value && onRange(from, e.target.value)}
            aria-label="To date"
            className="h-8 w-[9rem] text-xs"
          />
        </div>
      ) : (
        <DateField
          value={from === to ? from : ""}
          onChange={(e) => {
            const day = e.target.value;
            if (day) onRange(day, day);
          }}
          aria-label="Day"
          className="h-8 w-[9rem] text-xs"
        />
      )}

      <div className={SEGMENT}>
        {presets.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => {
              setCustomChosen(false);
              onRange(p.from, p.to);
            }}
            className={cn(
              SEGMENT_ITEM,
              !custom && p.from === from && p.to === to ? SEGMENT_ON : SEGMENT_OFF,
            )}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setCustomChosen(true)}
          className={cn(SEGMENT_ITEM, custom ? SEGMENT_ON : SEGMENT_OFF)}
        >
          Custom
        </button>
      </div>

      {children}
    </div>
  );
}
