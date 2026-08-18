/**
 * Shared types and pure helpers for the Automations screen. No React in here;
 * imported by the page (server) and the client components alike.
 */

export type RuleRow = {
  id: string;
  name: string;
  automation_id: string;
  trigger_event: string;
  /** Products the automation fires for. Null or empty = any product. */
  business_tour_ids: string[] | null;
  channel: "sms" | "whatsapp";
  body: string | null;
  whatsapp_content_sid: string | null;
  whatsapp_variables: Record<string, string> | null;
  only_first_contact: boolean;
  is_active: boolean;
  delay_minutes: number;
};

export type ProductOption = {
  id: string;
  name: string;
  businessName: string;
};

export type WaTemplateOption = {
  sid: string;
  name: string;
  body: string;
  status: string;
  rejectionReason?: string | null;
};

/**
 * Products grouped under their business. Every business sells its own copy of
 * the same tours, so a flat list is twenty rows of near-duplicates ("Jet Ski",
 * "Jet Ski", ...) that can only be told apart by a suffix. Grouped, the
 * business is said once as a heading and each product is named once.
 */
export function groupByBusiness(
  products: ProductOption[],
): { businessName: string; products: ProductOption[] }[] {
  const groups = new Map<string, ProductOption[]>();
  for (const product of products) {
    const list = groups.get(product.businessName);
    if (list) list.push(product);
    else groups.set(product.businessName, [product]);
  }
  return [...groups.entries()]
    .map(([businessName, list]) => ({
      businessName,
      products: [...list].sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.businessName.localeCompare(b.businessName));
}

/**
 * How a trigger's product set reads in the UI. Ids whose product no longer
 * exists are ignored: the column is an array, so it cannot carry a foreign key
 * that would clean up after a deleted product.
 */
export function productLabel(ids: string[] | null, products: ProductOption[]): string {
  const known = (ids ?? []).filter((id) => products.some((product) => product.id === id));
  if (known.length === 0) return "Any product";
  if (known.length > 1) return `${known.length} products`;
  const only = products.find((product) => product.id === known[0]);
  return only ? `${only.name} (${only.businessName})` : "Any product";
}

export const STATUS_TONE: Record<string, "success" | "warning" | "danger"> = {
  approved: "success",
  pending: "warning",
  rejected: "danger",
};

export type Channel = "sms" | "whatsapp";

export const ANY_KEY = "__any__";

/**
 * The events an automation can start from. Only "a new booking comes in" is
 * wired to the sending engine today; this list is the seam for adding more.
 *
 * The post-tour review funnel is deliberately NOT here. It branches on the
 * customer's reply and cancels itself on uncheck, which this rules model
 * cannot express, so it is a fixed flow instead. See docs/review-automation.md.
 */
export const TRIGGERS = [{ value: "new_booking", label: "A new booking comes in" }] as const;

export function triggerLabel(value: string): string {
  return TRIGGERS.find((t) => t.value === value)?.label ?? "A new booking comes in";
}

export const PLACEHOLDERS = ["first_name", "product_name", "booking_link", "booking_date"];

export const PLACEHOLDER_LABELS: Record<string, string> = {
  first_name: "Customer first name",
  product_name: "Product name",
  booking_link: "Ticket link",
  booking_date: "Tour date",
};

const SAMPLE_VALUES: Record<string, string> = {
  first_name: "Alex",
  product_name: "Miami Skyline Cruises",
  booking_link: "https://bked.io/booking/AB12CD",
  booking_date: "07/15/2026",
};

/** Fill {{placeholders}} with sample values for the live preview line. */
export function renderPreview(body: string): string {
  return body.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, name: string) => {
    return SAMPLE_VALUES[name.toLowerCase()] ?? match;
  });
}

export const UNIT_FACTOR: Record<"minutes" | "hours" | "days", number> = {
  minutes: 1,
  hours: 60,
  days: 1440,
};

export const MAX_DELAY_MINUTES = 43200; // 30 days

/** Human label for a delay, e.g. 90 -> "1 hour 30 minutes", 1440 -> "1 day". */
export function humanizeMinutes(total: number): string {
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} day${days > 1 ? "s" : ""}`);
  if (hours) parts.push(`${hours} hour${hours > 1 ? "s" : ""}`);
  if (minutes) parts.push(`${minutes} minute${minutes > 1 ? "s" : ""}`);
  return parts.slice(0, 2).join(" ") || "0 minutes";
}

/** Split stored minutes back into the editor's mode/value/unit. */
export function decomposeDelay(total: number): {
  mode: "immediately" | "delay";
  value: string;
  unit: "minutes" | "hours" | "days";
} {
  if (!total || total <= 0) return { mode: "immediately", value: "1", unit: "hours" };
  if (total % 1440 === 0) return { mode: "delay", value: String(total / 1440), unit: "days" };
  if (total % 60 === 0) return { mode: "delay", value: String(total / 60), unit: "hours" };
  return { mode: "delay", value: String(total), unit: "minutes" };
}
