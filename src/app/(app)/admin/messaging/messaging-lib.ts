/**
 * Shared types and pure helpers for the Automations screen. No React in here;
 * imported by the page (server) and the client components alike.
 */

export type RuleRow = {
  id: string;
  name: string;
  trigger_event: string;
  business_tour_id: string | null;
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
