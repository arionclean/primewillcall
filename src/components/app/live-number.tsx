"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * A number that flashes green when it goes up.
 *
 * These screens refresh themselves over Realtime, so a figure can change while
 * someone is looking straight at it and nothing marks the moment. The flash is
 * the whole point of updating live: a guest checked in, a sale landed, and the
 * number that moved says so.
 *
 * Only an increase flashes. A count going down is a cancellation or an undone
 * check-in, which is not news worth celebrating in green, and flashing on every
 * change would make the screen twitch.
 *
 * Nothing is fetched here. The component compares the value it was given with
 * the one it had, so it costs a render and a timer.
 */
export function LiveNumber({
  value,
  className,
}: {
  value: number;
  className?: string;
}) {
  const [bumped, setBumped] = useState(false);
  const previous = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (value > previous.current) {
      setBumped(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setBumped(false), 1600);
    }
    previous.current = value;
  }, [value]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <span
      className={cn(
        "inline-block origin-left tabular-nums transition-all duration-500",
        bumped && "text-emerald-600 motion-safe:scale-[1.06] dark:text-emerald-400",
        className,
      )}
    >
      {value.toLocaleString()}
    </span>
  );
}
