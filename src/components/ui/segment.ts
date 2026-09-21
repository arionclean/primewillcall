/**
 * The segmented control the filter bars are built from: a row of small buttons
 * in one bordered pill, the chosen one raised. Analytics set the look; Hours
 * uses the same classes so the two screens filter the same way.
 *
 * Classes rather than a component on purpose: the buttons do different things
 * on each screen (one sets a range, another switches the grouping), and only
 * the look is shared.
 */
export const SEGMENT = "inline-flex items-center rounded-lg border bg-muted/40 p-0.5";
export const SEGMENT_ITEM =
  "rounded-md px-2.5 py-1 text-xs font-medium transition whitespace-nowrap";
export const SEGMENT_ON = "bg-background text-foreground shadow-sm";
export const SEGMENT_OFF = "text-muted-foreground hover:text-foreground";
