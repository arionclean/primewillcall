"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  Filter,
  Ghost,
  PencilLine,
  StickyNote,
  Ticket,
  TicketCheck,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DateField } from "@/components/ui/date-field";
import { PhoneInput } from "@/components/ui/phone-input";
import { Textarea } from "@/components/ui/textarea";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

import { PaymentLinkButton } from "./payment-link-button";

const PRIVACY_KEY = "pwc.bookings.privacy";
const TZ = "America/New_York";

const slotTimeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
});

/** "10:30:00" or "10:30" -> "10:30". */
function normalizeHHMM(t: string): string {
  const m = /^(\d{2}):(\d{2})/.exec(t);
  return m ? `${m[1]}:${m[2]}` : t;
}

/** "10:30" -> "10:30 AM" for display. */
function slotLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h)) return hhmm;
  return slotTimeFormatter.format(new Date(2000, 0, 1, h, m ?? 0));
}

const BOOKING_SELECT = `
  id,
  starts_at,
  ends_at,
  status,
  total_cents,
  currency,
  business_id,
  business_tour_id,
  customer_id,
  checked_in_at,
  source_channel,
  groupon_redeemed_at,
  pax_adult,
  pax_child,
  pax_infant,
  notes,
  business_tour:business_tours!bookings_business_tour_id_fkey(
    id,
    name,
    tour:tours(id, name, capacity)
  ),
  customer:customers!bookings_customer_id_fkey(id, full_name, phone, email)
`;

type BookingStatus =
  | "pending"
  | "confirmed"
  | "checked_in"
  | "completed"
  | "cancelled";

/**
 * A booking's payment status. Confirmed is the normal state and shows no tag.
 * Only the states that need the operator's attention get a badge. Check-in is a
 * separate concern (its own column, driven by `checked_in_at`), not a status.
 */
function statusBadge(
  status: BookingStatus,
): { label: string; tone: "warning" | "danger" } | null {
  if (status === "cancelled") return { label: "Cancelled", tone: "danger" };
  if (status === "pending")
    return { label: "Waiting for payment", tone: "warning" };
  return null; // confirmed (and any legacy checked_in / completed) -> no tag
}

// The payment statuses a user can set. Check-in is toggled separately.
const STATUS_OPTIONS: { value: BookingStatus; label: string }[] = [
  { value: "confirmed", label: "Confirmed" },
  { value: "pending", label: "Waiting for payment" },
  { value: "cancelled", label: "Cancelled" },
];

export type TourOption = {
  id: string; // business_tours.id
  name: string; // variant name (customer-facing)
  businessId: string;
  businessName: string;
  masterTourName: string;
  capacity: number;
  color: string | null;
  tiers: { id: string; label: string; price_cents: number }[]; // sorted by sort_order
  slots: { start_time: string; duration_minutes: number }[]; // sorted by sort_order
};

/** Soft row tint + accent from a tour's hex color (e.g. "#17DB4E"). */
function tourTint(color: string | null | undefined): {
  background?: string;
  borderLeft?: string;
} {
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return {};
  return {
    background: `${color}14`, // ~8% alpha
    borderLeft: `3px solid ${color}`,
  };
}

export type BookingRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: BookingStatus;
  total_cents: number;
  currency: string;
  business_id: string;
  business_tour_id: string;
  customer_id: string | null;
  checked_in_at: string | null;
  source_channel: string | null;
  groupon_redeemed_at: string | null;
  pax_adult: number;
  pax_child: number;
  pax_infant: number;
  notes: string | null;
  business_tour: {
    id: string;
    name: string;
    tour: { id: string; name: string; capacity: number } | null;
  } | null;
  customer: {
    id: string;
    full_name: string;
    phone: string | null;
    email: string | null;
  } | null;
};

/** Owner-editable per-staff booking permissions (see /admin/staff/[id]). */
export type BookingCaps = {
  canCreateBookings: boolean;
  canEditBookings: boolean;
  canCheckIn: boolean;
  canDeleteBookings: boolean;
};

type BookingsListProps = {
  initial: BookingRow[];
  tours: TourOption[];
  date: string; // YYYY-MM-DD
  role: "owner" | "business_manager" | "check_in";
  caps: BookingCaps;
  businessId: string | null; // scopes the realtime subscription for non-owners
  rangeStartUtc: string;
  rangeEndUtcExclusive: string;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a NY-local YYYY-MM-DD + HH:MM into a UTC ISO string. */
function nyLocalToUtcIso(yyyyMmDd: string, hhmm: string): string {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  const parts = hhmm.split(":").map(Number);
  const hh = parts[0] ?? 0;
  const mm = parts[1] ?? 0;
  const candidate = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
  const tzLabel =
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      timeZoneName: "shortOffset",
      hour: "2-digit",
      hour12: false,
    })
      .formatToParts(candidate)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";
  const m2 = tzLabel.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  const sign = m2?.[1] === "-" ? -1 : 1;
  const offMin = sign * (Number(m2?.[2] ?? 0) * 60 + Number(m2?.[3] ?? 0));
  return new Date(candidate.getTime() - offMin * 60_000).toISOString();
}

/** Format a UTC ISO instant to the NY-local YYYY-MM-DD date input value. */
function toNyDateInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Format a UTC ISO instant to the NY-local HH:MM time input value. */
function toNyTimeInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hh = get("hour") === "24" ? "00" : get("hour");
  return `${hh}:${get("minute")}`;
}

function toNonNegativeInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

async function copyTextToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    try {
      return document.execCommand("copy");
    } finally {
      document.body.removeChild(textarea);
    }
  }
}

function maskName(full: string): string {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const first = parts[0];
  const lastInitial = parts[parts.length - 1]?.[0] ?? "";
  return lastInitial ? `${first} ${lastInitial}.` : first;
}

function maskPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  const last4 = digits.slice(-4).padStart(4, "0");
  return `ooo ooo ${last4}`;
}

function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw;
}

function describePax(b: Pick<BookingRow, "pax_adult" | "pax_child" | "pax_infant">): string {
  const parts: string[] = [];
  if (b.pax_adult)
    parts.push(`${b.pax_adult} adult${b.pax_adult === 1 ? "" : "s"}`);
  if (b.pax_child)
    parts.push(`${b.pax_child} child${b.pax_child === 1 ? "" : "ren"}`);
  if (b.pax_infant)
    parts.push(`${b.pax_infant} infant${b.pax_infant === 1 ? "" : "s"}`);
  return parts.length ? parts.join(", ") : "no pax";
}

const dateLabelFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  month: "short",
  day: "numeric",
  year: "numeric",
});
const timeLabelFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});
const slotKeyFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

// ── HoverTooltip (ported from legacy) ────────────────────────────────────────

type HoverTooltipProps = {
  label: string;
  children: ReactNode;
  className?: string;
  onlyWhenTruncated?: boolean;
};

function HoverTooltip({
  label,
  children,
  className,
  onlyWhenTruncated = true,
}: HoverTooltipProps) {
  const trimmedLabel = label.trim();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [tooltipLayout, setTooltipLayout] = useState<{
    arrowLeft: number;
    left: number;
    maxWidth: number;
    placement: "top" | "bottom";
    top: number;
  } | null>(null);

  const updatePlacement = () => {
    const node = contentRef.current;
    if (!node) {
      return;
    }

    const rect = node.getBoundingClientRect();
    const viewportPadding = 12;
    const maxWidth = Math.min(352, window.innerWidth - viewportPadding * 2);
    const targetCenter = rect.left + rect.width / 2;
    const clampedCenter = Math.min(
      Math.max(targetCenter, viewportPadding + maxWidth / 2),
      window.innerWidth - viewportPadding - maxWidth / 2,
    );
    const placement =
      rect.top < 96 && window.innerHeight - rect.bottom > rect.top
        ? "bottom"
        : "top";
    const arrowLimit = Math.max(maxWidth / 2 - 20, 0);
    const arrowLeft = Math.max(
      Math.min(targetCenter - clampedCenter, arrowLimit),
      -arrowLimit,
    );

    setTooltipLayout({
      arrowLeft,
      left: clampedCenter,
      maxWidth,
      placement,
      top: placement === "top" ? rect.top - 12 : rect.bottom + 12,
    });
  };

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (!trimmedLabel) {
      setIsVisible(false);
      return;
    }

    if (!onlyWhenTruncated) {
      setIsVisible(true);
      return;
    }

    const node = contentRef.current;
    if (!node) {
      setIsVisible(false);
      return;
    }

    const measureOverflow = () => {
      const target = (node.firstElementChild as HTMLElement | null) ?? node;
      const hasOverflow =
        target.scrollWidth - target.clientWidth > 1 ||
        target.scrollHeight - target.clientHeight > 1;
      setIsVisible(hasOverflow);
      if (hasOverflow) {
        updatePlacement();
      }
    };

    measureOverflow();

    const resizeObserver = new ResizeObserver(measureOverflow);
    resizeObserver.observe(node);
    const target = (node.firstElementChild as HTMLElement | null) ?? null;
    if (target) {
      resizeObserver.observe(target);
    }
    window.addEventListener("resize", measureOverflow);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", measureOverflow);
    };
  }, [children, onlyWhenTruncated, trimmedLabel]);

  useEffect(() => {
    if (!isOpen || !isVisible) {
      return;
    }

    updatePlacement();

    const handlePositionUpdate = () => updatePlacement();
    window.addEventListener("resize", handlePositionUpdate);
    window.addEventListener("scroll", handlePositionUpdate, true);

    return () => {
      window.removeEventListener("resize", handlePositionUpdate);
      window.removeEventListener("scroll", handlePositionUpdate, true);
    };
  }, [isOpen, isVisible, trimmedLabel]);

  useEffect(() => {
    if (!isVisible) {
      setIsOpen(false);
    }
  }, [isVisible]);

  if (!trimmedLabel) {
    return <>{children}</>;
  }

  return (
    <div
      className={cn("min-w-0", className)}
      onMouseEnter={() => {
        updatePlacement();
        setIsOpen(true);
      }}
      onMouseLeave={() => setIsOpen(false)}
      onFocusCapture={() => {
        updatePlacement();
        setIsOpen(true);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsOpen(false);
        }
      }}
    >
      <div ref={contentRef} className="min-w-0">
        {children}
      </div>
      {isMounted && isVisible && isOpen && tooltipLayout
        ? createPortal(
            <div
              className={cn(
                "pointer-events-none fixed z-[80] w-max -translate-x-1/2",
                tooltipLayout.placement === "top" ? "-translate-y-full" : "",
              )}
              style={{
                left: tooltipLayout.left,
                maxWidth: tooltipLayout.maxWidth,
                top: tooltipLayout.top,
              }}
            >
              <div className="relative rounded-2xl bg-foreground px-4 py-2.5 text-center text-sm leading-snug text-background shadow-2xl animate-in fade-in zoom-in-95 duration-200">
                {trimmedLabel}
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute size-3 rotate-45 bg-foreground",
                    tooltipLayout.placement === "top"
                      ? "top-full -translate-y-1/2"
                      : "bottom-full translate-y-1/2",
                  )}
                  style={{ left: `calc(50% + ${tooltipLayout.arrowLeft}px)` }}
                />
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

// ── Grouping ─────────────────────────────────────────────────────────────────

type Group = {
  slotKey: string;
  slotLabel: string;
  rows: BookingRow[];
  totalPax: number;
  checkedPax: number;
};

function paxOf(b: BookingRow): number {
  return (b.pax_adult ?? 0) + (b.pax_child ?? 0) + (b.pax_infant ?? 0);
}

function groupByTime(rows: BookingRow[]): Group[] {
  const buckets = new Map<
    string,
    { rows: BookingRow[]; totalPax: number; checkedPax: number; first: string }
  >();

  for (const b of rows) {
    const d = new Date(b.starts_at);
    if (Number.isNaN(d.getTime())) continue;
    const slotKey = slotKeyFormatter.format(d); // HH:MM in NY
    const existing = buckets.get(slotKey) ?? {
      rows: [],
      totalPax: 0,
      checkedPax: 0,
      first: b.starts_at,
    };
    const pax = paxOf(b);
    existing.rows.push(b);
    existing.totalPax += pax;
    if (b.checked_in_at != null) {
      existing.checkedPax += pax;
    }
    buckets.set(slotKey, existing);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([slotKey, metrics]) => {
      const sortedRows = metrics.rows
        .slice()
        .sort((a, b) => (a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : 0));
      const d = new Date(metrics.first);
      const slotLabel = `${dateLabelFormatter.format(d)} ${timeLabelFormatter.format(d)}`;
      return {
        slotKey,
        slotLabel,
        rows: sortedRows,
        totalPax: metrics.totalPax,
        checkedPax: metrics.checkedPax,
      };
    });
}

// ── Note popover placement type ──────────────────────────────────────────────

type NotePopoverLayout = {
  arrowLeft: number;
  left: number;
  placement: "top" | "bottom";
  top: number;
  width: number;
};

// ── Main component ───────────────────────────────────────────────────────────

export function BookingsList({
  initial,
  tours,
  date,
  role,
  caps,
  businessId,
  rangeStartUtc,
  rangeEndUtcExclusive,
}: BookingsListProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const focusedBookingId = searchParams.get("booking")?.trim() ?? "";

  const [bookings, setBookings] = useState<BookingRow[]>(initial);
  const [privacyOn, setPrivacyOn] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const [selectedTourIds, setSelectedTourIds] = useState<string[]>([]);
  const [draftTourIds, setDraftTourIds] = useState<string[]>([]);
  const [isFilterOpen, setIsFilterOpen] = useState(false);

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [highlightedBookingId, setHighlightedBookingId] = useState<string | null>(
    null,
  );

  // Edit modal target booking (null when closed).
  const [editBooking, setEditBooking] = useState<BookingRow | null>(null);

  // Note popover.
  const [openNoteBookingId, setOpenNoteBookingId] = useState<string | null>(null);
  const [openNoteLayout, setOpenNoteLayout] = useState<NotePopoverLayout | null>(
    null,
  );
  const openNoteContainerRef = useRef<HTMLDivElement | null>(null);
  const openNotePanelRef = useRef<HTMLDivElement | null>(null);
  const openNoteTriggerRef = useRef<HTMLElement | null>(null);

  // Reset local state when the server-fetched window changes.
  useEffect(() => {
    setBookings(initial);
  }, [initial]);

  // Hydrate privacy toggle from localStorage (mount only, avoids hydration mismatch).
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(PRIVACY_KEY);
      if (stored === "1") setPrivacyOn(true);
    } catch {
      // ignore
    }
  }, []);

  function togglePrivacy() {
    setPrivacyOn((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(PRIVACY_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }

  const refresh = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();
    const { data, error } = await supabase
      .from("bookings")
      .select(BOOKING_SELECT)
      .gte("starts_at", rangeStartUtc)
      .lt("starts_at", rangeEndUtcExclusive)
      .order("starts_at", { ascending: true });

    if (error) {
      console.error("[bookings] refresh failed:", error);
      return;
    }
    setBookings((data ?? []) as unknown as BookingRow[]);
  }, [rangeStartUtc, rangeEndUtcExclusive]);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    // Non-owners only react to their own business's changes, so an unrelated
    // business updating a booking never triggers a refetch here.
    const changes = {
      event: "*",
      schema: "public",
      table: "bookings",
      ...(businessId ? { filter: `business_id=eq.${businessId}` } : {}),
    } as const;
    const channel = supabase
      .channel("bookings-list")
      .on("postgres_changes", changes, () =>
        startTransition(() => void refresh()),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [refresh, businessId]);

  // ── Tour filter ────────────────────────────────────────────────────────────

  const tourById = useMemo(() => {
    const map = new Map<string, TourOption>();
    for (const t of tours) map.set(t.id, t);
    return map;
  }, [tours]);

  const selectedTourSet = useMemo(
    () => new Set(selectedTourIds),
    [selectedTourIds],
  );

  const tourFilterLabel = useMemo(() => {
    if (tours.length === 0) return "No tours";
    if (selectedTourIds.length === 0) return "All tours";
    if (selectedTourIds.length === 1) {
      const t = tourById.get(selectedTourIds[0]);
      return t?.name ?? "Selected tour";
    }
    return `${selectedTourIds.length} tours`;
  }, [tourById, tours.length, selectedTourIds]);

  function openFilter() {
    setDraftTourIds(selectedTourIds);
    setIsFilterOpen(true);
  }

  function applyFilter() {
    setSelectedTourIds(draftTourIds);
    setIsFilterOpen(false);
  }

  function toggleDraftTour(id: string) {
    setDraftTourIds((current) => {
      if (current.length === 0) return [id];
      const next = current.includes(id)
        ? current.filter((x) => x !== id)
        : [...current, id];
      if (next.length === 0 || next.length === tours.length) return [];
      return next;
    });
  }

  // ── Filtering + grouping ───────────────────────────────────────────────────

  const filtered = useMemo(() => {
    // Text search lives in the global sidebar search (Cmd/Ctrl+K). Here we only
    // filter by the selected tour; the date is already scoped by the page.
    if (selectedTourIds.length === 0) return bookings;
    return bookings.filter((b) => selectedTourSet.has(b.business_tour_id));
  }, [bookings, selectedTourIds.length, selectedTourSet]);

  const groups = useMemo(() => groupByTime(filtered), [filtered]);

  // ── Deep-link highlight (ported) ───────────────────────────────────────────

  useEffect(() => {
    if (!focusedBookingId) {
      setHighlightedBookingId(null);
      return;
    }
    if (!filtered.some((b) => b.id === focusedBookingId)) {
      return;
    }

    let clearTimer: number | undefined;
    const frame = window.requestAnimationFrame(() => {
      const row = document.getElementById(`booking-${focusedBookingId}`);
      row?.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlightedBookingId(focusedBookingId);

      const nextParams = new URLSearchParams(window.location.search);
      nextParams.delete("booking");
      const nextQuery = nextParams.toString();
      const nextUrl = nextQuery
        ? `${window.location.pathname}?${nextQuery}`
        : window.location.pathname;
      window.history.replaceState(null, "", nextUrl);

      clearTimer = window.setTimeout(() => {
        setHighlightedBookingId((current) =>
          current === focusedBookingId ? null : current,
        );
      }, 3000);
    });

    return () => {
      window.cancelAnimationFrame(frame);
      if (clearTimer) window.clearTimeout(clearTimer);
    };
  }, [filtered, focusedBookingId]);

  // ── Copy field ─────────────────────────────────────────────────────────────

  const handleCopyField = useCallback(
    async (key: string, value: string, errorMessage: string) => {
      if (await copyTextToClipboard(value)) {
        setCopiedKey(key);
        window.setTimeout(() => {
          setCopiedKey((current) => (current === key ? null : current));
        }, 1400);
        return;
      }
      setErrorMsg(errorMessage);
    },
    [],
  );

  // ── Check-in toggle (optimistic + browser client) ──────────────────────────

  const handleToggleCheckIn = useCallback(
    async (booking: BookingRow) => {
      // Check-in is independent of payment status. Toggling only stamps or
      // clears checked_in_at; status (confirmed / waiting / cancelled) is left
      // alone.
      const nextCheckedInAt =
        booking.checked_in_at == null ? new Date().toISOString() : null;
      const prevCheckedInAt = booking.checked_in_at;

      setBusyId(booking.id);
      setErrorMsg(null);
      setBookings((current) =>
        current.map((b) =>
          b.id === booking.id ? { ...b, checked_in_at: nextCheckedInAt } : b,
        ),
      );

      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase
        .from("bookings")
        .update({ checked_in_at: nextCheckedInAt })
        .eq("id", booking.id);

      if (error) {
        setBookings((current) =>
          current.map((b) =>
            b.id === booking.id
              ? { ...b, checked_in_at: prevCheckedInAt }
              : b,
          ),
        );
        setErrorMsg(`Unable to update check-in: ${error.message}`);
      }
      setBusyId(null);
    },
    [],
  );

  // ── Groupon "redeemed" toggle (owner only, optimistic) ─────────────────────

  const handleToggleRedeem = useCallback(
    async (booking: BookingRow) => {
      // Records that the owner has redeemed this Groupon voucher on Groupon's
      // platform. Independent of check-in and payment status: it only
      // stamps/clears groupon_redeemed_at.
      const nextRedeemedAt =
        booking.groupon_redeemed_at == null ? new Date().toISOString() : null;
      const prevRedeemedAt = booking.groupon_redeemed_at;

      setBusyId(booking.id);
      setErrorMsg(null);
      setBookings((current) =>
        current.map((b) =>
          b.id === booking.id ? { ...b, groupon_redeemed_at: nextRedeemedAt } : b,
        ),
      );

      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase
        .from("bookings")
        .update({ groupon_redeemed_at: nextRedeemedAt })
        .eq("id", booking.id);

      if (error) {
        setBookings((current) =>
          current.map((b) =>
            b.id === booking.id
              ? { ...b, groupon_redeemed_at: prevRedeemedAt }
              : b,
          ),
        );
        setErrorMsg(`Unable to update redemption: ${error.message}`);
      }
      setBusyId(null);
    },
    [],
  );

  // ── Note popover placement (ported) ────────────────────────────────────────

  const updateNotePlacement = useCallback((trigger: HTMLElement | null) => {
    if (!trigger) {
      openNoteTriggerRef.current = null;
      setOpenNoteLayout(null);
      return;
    }

    openNoteTriggerRef.current = trigger;

    const triggerRect = trigger.getBoundingClientRect();
    const viewportPadding = 12;
    const width = Math.min(320, window.innerWidth - viewportPadding * 2);
    const left = Math.min(
      Math.max(triggerRect.right - width, viewportPadding),
      window.innerWidth - width - viewportPadding,
    );
    const triggerCenter = triggerRect.left + triggerRect.width / 2;
    const arrowLeft = Math.min(Math.max(triggerCenter - left, 18), width - 18);
    const spaceBelow = window.innerHeight - triggerRect.bottom;
    const spaceAbove = triggerRect.top;
    const placement = spaceBelow < 300 && spaceAbove > spaceBelow ? "top" : "bottom";

    setOpenNoteLayout({
      arrowLeft,
      left,
      placement,
      top: placement === "top" ? triggerRect.top - 12 : triggerRect.bottom + 12,
      width,
    });
  }, []);

  useEffect(() => {
    if (!openNoteBookingId) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        openNoteContainerRef.current &&
        !openNoteContainerRef.current.contains(target) &&
        !openNotePanelRef.current?.contains(target)
      ) {
        setOpenNoteBookingId(null);
        setOpenNoteLayout(null);
        openNoteTriggerRef.current = null;
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenNoteBookingId(null);
        setOpenNoteLayout(null);
        openNoteTriggerRef.current = null;
      }
    };

    const handlePositionUpdate = () => {
      updateNotePlacement(openNoteTriggerRef.current);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener("resize", handlePositionUpdate);
    window.addEventListener("scroll", handlePositionUpdate, true);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("resize", handlePositionUpdate);
      window.removeEventListener("scroll", handlePositionUpdate, true);
    };
  }, [openNoteBookingId, updateNotePlacement]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="grid gap-2 sm:max-w-[760px] sm:grid-cols-3">
        <div className="rounded-xl border bg-card p-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Date
          </p>
          <DateField
            value={date}
            onChange={(e) => {
              const v = e.target.value;
              if (v) router.push(`/bookings?date=${v}`);
            }}
            aria-label="Bookings date"
            className="mt-1.5 h-9 w-full rounded-md border bg-background px-2 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </div>

        <div className="rounded-xl border bg-card p-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Tour
          </p>
          <button
            type="button"
            onClick={openFilter}
            disabled={tours.length === 0}
            aria-haspopup="dialog"
            aria-expanded={isFilterOpen}
            className="mt-1.5 inline-flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 text-sm text-foreground/80 transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="flex min-w-0 items-center gap-2">
              <Filter className="size-4 shrink-0 text-indigo-500" />
              <span className="truncate">{tourFilterLabel}</span>
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </div>

        <div className="rounded-xl border bg-card p-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Privacy
          </p>
          <button
            type="button"
            onClick={togglePrivacy}
            aria-pressed={privacyOn}
            className="mt-1.5 inline-flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 text-sm text-foreground/80 transition hover:bg-muted"
          >
            <span>{privacyOn ? "Privacy on" : "Privacy mode"}</span>
            {privacyOn ? (
              <EyeOff className="size-5 text-indigo-500" />
            ) : (
              <Eye className="size-5 text-indigo-500" />
            )}
          </button>
        </div>
      </div>

      {errorMsg && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {errorMsg}
        </p>
      )}

      {groups.length === 0 ? (
        <EmptyState />
      ) : (
        <section className="relative rounded-xl bg-card">
          <div>
            {groups.map((group) => (
              <div
                key={group.slotKey}
                className="border-t pb-4 first:border-t-0 last:pb-0"
              >
                <header className="sticky top-0 z-20 grid grid-cols-[1fr_auto] items-center gap-2 bg-card/95 px-3 py-2.5 backdrop-blur">
                  <p className="text-2xl font-semibold tracking-tight">
                    {group.slotLabel}
                  </p>
                  <p className="text-2xl font-semibold tracking-tight">
                    {group.checkedPax}{" "}
                    <span className="text-muted-foreground">
                      of {group.totalPax}
                    </span>
                  </p>
                </header>

                <div className="mt-2">
                  {group.rows.map((booking) => (
                    <BookingRowItem
                      key={booking.id}
                      booking={booking}
                      role={role}
                      caps={caps}
                      privacyOn={privacyOn}
                      busy={busyId === booking.id}
                      copiedKey={copiedKey}
                      highlighted={highlightedBookingId === booking.id}
                      onCopyField={handleCopyField}
                      onToggleCheckIn={() => void handleToggleCheckIn(booking)}
                      onToggleRedeem={() => void handleToggleRedeem(booking)}
                      onEdit={() => setEditBooking(booking)}
                      noteOpen={openNoteBookingId === booking.id}
                      noteLayout={
                        openNoteBookingId === booking.id ? openNoteLayout : null
                      }
                      openNoteContainerRef={
                        openNoteBookingId === booking.id
                          ? openNoteContainerRef
                          : null
                      }
                      openNotePanelRef={openNotePanelRef}
                      businessName={
                        tourById.get(booking.business_tour_id)?.businessName ??
                        ""
                      }
                      color={
                        tourById.get(booking.business_tour_id)?.color ?? null
                      }
                      onToggleNote={(trigger) => {
                        setOpenNoteBookingId((current) => {
                          const nextIsOpen = current !== booking.id;
                          if (nextIsOpen) {
                            updateNotePlacement(trigger);
                          } else {
                            setOpenNoteLayout(null);
                            openNoteTriggerRef.current = null;
                          }
                          return current === booking.id ? null : booking.id;
                        });
                      }}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Tour filter modal */}
      {isFilterOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4 py-6 animate-in fade-in duration-200"
          role="presentation"
          onMouseDown={() => setIsFilterOpen(false)}
        >
          <div
            aria-labelledby="tour-filter-title"
            aria-modal="true"
            className="flex max-h-[88vh] w-full max-w-[28rem] flex-col overflow-hidden rounded-xl border bg-card shadow-2xl animate-in fade-in zoom-in-95 slide-in-from-bottom-4 duration-300"
            role="dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="border-b px-5 py-4 text-center">
              <h2
                id="tour-filter-title"
                className="text-lg font-semibold tracking-tight"
              >
                Filter by tour
              </h2>
            </div>

            <div className="grid gap-1.5 overflow-y-auto px-5 py-4">
              <button
                type="button"
                onClick={() => setDraftTourIds([])}
                aria-pressed={draftTourIds.length === 0}
                className={cn(
                  "flex min-h-12 w-full items-center justify-between gap-3 rounded-lg border px-3 text-left text-sm font-medium transition-colors",
                  draftTourIds.length === 0
                    ? "border-indigo-200 bg-indigo-50 text-indigo-600"
                    : "border-transparent text-foreground hover:bg-muted",
                )}
              >
                <span>All tours</span>
                {draftTourIds.length === 0 ? (
                  <Check className="size-5 shrink-0" />
                ) : null}
              </button>

              {tours.map((tour) => {
                const isSelected = draftTourIds.includes(tour.id);
                return (
                  <button
                    key={tour.id}
                    type="button"
                    onClick={() => toggleDraftTour(tour.id)}
                    aria-pressed={isSelected}
                    className={cn(
                      "flex min-h-12 w-full items-center justify-between gap-3 rounded-lg border px-3 text-left text-sm font-medium transition-colors",
                      isSelected
                        ? "border-indigo-200 bg-indigo-50 text-indigo-600"
                        : "border-transparent text-foreground hover:bg-muted",
                    )}
                  >
                    <span className="min-w-0 truncate">
                      {tour.name || tour.masterTourName || "Unnamed tour"}
                      {role === "owner" && tour.businessName ? (
                        <span className="ml-1 text-xs text-muted-foreground">
                          ({tour.businessName})
                        </span>
                      ) : null}
                    </span>
                    {isSelected ? <Check className="size-5 shrink-0" /> : null}
                  </button>
                );
              })}
            </div>

            <div className="border-t bg-muted/40 px-5 py-4">
              <Button type="button" onClick={applyFilter} className="h-10 w-full">
                Done
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Edit modal */}
      {editBooking ? (
        <EditBookingModal
          key={editBooking.id}
          booking={editBooking}
          tours={tours}
          role={role}
          caps={caps}
          onClose={() => setEditBooking(null)}
          onSaved={(updated) => {
            setBookings((current) =>
              current.map((b) => (b.id === updated.id ? updated : b)),
            );
            setEditBooking(null);
          }}
          onDeleted={(id) => {
            setBookings((current) => current.filter((b) => b.id !== id));
            setEditBooking(null);
          }}
        />
      ) : null}
    </div>
  );
}

// ── Row ──────────────────────────────────────────────────────────────────────

const rowActionButtonClass =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-transparent text-indigo-500 transition hover:border-indigo-200 hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

function BookingRowItem({
  booking,
  role,
  caps,
  privacyOn,
  busy,
  copiedKey,
  highlighted,
  onCopyField,
  onToggleCheckIn,
  onToggleRedeem,
  onEdit,
  businessName,
  color,
  noteOpen,
  noteLayout,
  openNoteContainerRef,
  openNotePanelRef,
  onToggleNote,
}: {
  booking: BookingRow;
  role: "owner" | "business_manager" | "check_in";
  caps: BookingCaps;
  privacyOn: boolean;
  busy: boolean;
  copiedKey: string | null;
  highlighted: boolean;
  onCopyField: (key: string, value: string, errorMessage: string) => void;
  onToggleCheckIn: () => void;
  onToggleRedeem: () => void;
  onEdit: () => void;
  businessName: string;
  color: string | null;
  noteOpen: boolean;
  noteLayout: NotePopoverLayout | null;
  openNoteContainerRef: React.RefObject<HTMLDivElement | null> | null;
  openNotePanelRef: React.RefObject<HTMLDivElement | null>;
  onToggleNote: (trigger: HTMLElement | null) => void;
}) {
  const shortRef = booking.id.slice(0, 8).toUpperCase();
  const name = booking.customer?.full_name ?? "";
  const displayName = name
    ? privacyOn
      ? maskName(name)
      : name
    : "(walk-up)";
  const phoneRaw = booking.customer?.phone ?? "";
  const displayPhone = phoneRaw
    ? privacyOn
      ? maskPhone(phoneRaw)
      : formatPhone(phoneRaw)
    : "";

  const tourName =
    booking.business_tour?.name ??
    booking.business_tour?.tour?.name ??
    "(unknown)";

  const cancelled = booking.status === "cancelled";
  const checkedIn = booking.checked_in_at != null;
  // Groupon vouchers are redeemed by the owner on Groupon's platform, then
  // marked here. The toggle is owner-only (they own the Groupon relationship).
  const canRedeem = role === "owner" && booking.source_channel === "groupon";
  const redeemed = booking.groupon_redeemed_at != null;
  const badge = statusBadge(booking.status);
  const paxBreakdown = describePax(booking);
  const note = booking.notes?.trim() ?? "";

  const totalPax = booking.pax_adult + booking.pax_child + booking.pax_infant;
  const tint = tourTint(color);

  return (
    <article
      id={`booking-${booking.id}`}
      style={tint}
      className={cn(
        "scroll-mt-28 border-b border-border/60 transition-all last:border-b-0",
        cancelled && "opacity-75",
        highlighted
          ? "relative z-10 rounded-md ring-2 ring-indigo-400 ring-offset-2 ring-offset-background shadow-lg"
          : "",
      )}
    >
      {/* Compact layout for phones and tablets (below lg). */}
      <div className="flex items-start gap-3 px-3 py-3 lg:hidden">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <HoverTooltip label={name}>
              <p className="truncate font-semibold">{displayName}</p>
            </HoverTooltip>
            {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span className="font-mono tabular-nums">#{shortRef}</span>
            {displayPhone ? (
              <>
                <span aria-hidden>·</span>
                <span>{displayPhone}</span>
              </>
            ) : null}
            <span aria-hidden>·</span>
            <span>{totalPax} pax</span>
            <span aria-hidden>·</span>
            <span className="truncate">{tourName}</span>
            {note ? (
              <StickyNote
                className="size-3.5 shrink-0"
                aria-label="Has a note"
              />
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          {canRedeem ? (
            <GrouponRedeemButton
              redeemed={redeemed}
              busy={busy}
              onToggle={onToggleRedeem}
            />
          ) : null}
          <input
            type="checkbox"
            checked={checkedIn}
            onChange={onToggleCheckIn}
            disabled={busy || cancelled || !caps.canCheckIn}
            aria-label="Toggle check-in"
            className="size-5 accent-fuchsia-600 disabled:cursor-not-allowed disabled:opacity-50"
          />
          {caps.canEditBookings ? (
            <button type="button" onClick={onEdit} className={rowActionButtonClass}>
              <span className="sr-only">Edit booking</span>
              <PencilLine className="size-4" />
            </button>
          ) : null}
        </div>
      </div>

      {/* Dense grid for desktop (lg and up). */}
      <div className="hidden items-center gap-3 px-3 py-3 text-sm lg:grid lg:grid-cols-[7rem_minmax(11rem,1.3fr)_minmax(8.5rem,.85fr)_3rem_2.5rem_minmax(10rem,1.1fr)_auto]">
      {/* ID + copy */}
      <div className="flex w-fit items-center gap-1 justify-self-start">
        <span className="shrink-0 text-xs font-medium text-muted-foreground">
          ID
        </span>
        {!privacyOn ? (
          <button
            type="button"
            onClick={() =>
              onCopyField(
                `${booking.id}:id`,
                booking.id,
                "Unable to copy booking ID.",
              )
            }
            title={shortRef}
            className="relative inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <span className="sr-only">Copy booking ID</span>
            {copiedKey === `${booking.id}:id` ? (
              <>
                <Check className="size-3.5 animate-in zoom-in-75 text-emerald-600" />
                <CopiedBubble />
              </>
            ) : (
              <Copy className="size-3.5" />
            )}
          </button>
        ) : null}
        <span className="hidden font-mono text-xs text-muted-foreground tabular-nums sm:inline">
          {shortRef}
        </span>
      </div>

      {/* Customer name + status badge */}
      <div className="min-w-0">
        <HoverTooltip label={name}>
          <p className="truncate font-semibold">{displayName}</p>
        </HoverTooltip>
        {badge ? (
          <div className="mt-0.5">
            <Badge tone={badge.tone}>{badge.label}</Badge>
          </div>
        ) : null}
      </div>

      {/* Phone + copy */}
      <div className="flex min-w-0 w-full items-center justify-between gap-1">
        <HoverTooltip label={displayPhone} className="flex-1">
          <p className="truncate text-muted-foreground">{displayPhone}</p>
        </HoverTooltip>
        {phoneRaw && !privacyOn ? (
          <button
            type="button"
            onClick={() =>
              onCopyField(
                `${booking.id}:phone`,
                phoneRaw,
                "Unable to copy phone number.",
              )
            }
            className="relative inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <span className="sr-only">Copy phone number</span>
            {copiedKey === `${booking.id}:phone` ? (
              <>
                <Check className="size-3.5 animate-in zoom-in-75 text-emerald-600" />
                <CopiedBubble />
              </>
            ) : (
              <Copy className="size-3.5" />
            )}
          </button>
        ) : null}
      </div>

      {/* Pax */}
      <HoverTooltip label={paxBreakdown} onlyWhenTruncated={false}>
        <div className="flex items-center gap-2 text-base font-semibold">
          <span>{booking.pax_adult}</span>
          {booking.pax_child > 0 ? (
            <span className="text-sky-500">{booking.pax_child}</span>
          ) : null}
          {booking.pax_infant > 0 ? (
            <span className="text-violet-400">/{booking.pax_infant}</span>
          ) : null}
        </div>
      </HoverTooltip>

      {/* Check-in checkbox */}
      <div className="flex justify-center">
        <input
          type="checkbox"
          checked={checkedIn}
          onChange={onToggleCheckIn}
          disabled={busy || cancelled || !caps.canCheckIn}
          aria-label="Toggle check-in"
          className="size-4 accent-fuchsia-600 disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>

      {/* Tour name (hidden on small screens) */}
      <div className="hidden min-w-0 lg:block">
        <HoverTooltip label={tourName}>
          <p className="truncate text-muted-foreground">{tourName}</p>
        </HoverTooltip>
        {role === "owner" && businessName ? (
          <p className="truncate text-[11px] text-muted-foreground/70">
            {businessName}
          </p>
        ) : null}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2">
        {canRedeem ? (
          <GrouponRedeemButton
            redeemed={redeemed}
            busy={busy}
            onToggle={onToggleRedeem}
          />
        ) : null}
        {note ? (
          <div
            ref={openNoteContainerRef}
            className="relative"
          >
            <button
              type="button"
              onClick={(event) => {
                const trigger =
                  event.currentTarget instanceof HTMLElement
                    ? event.currentTarget
                    : null;
                onToggleNote(trigger);
              }}
              className={cn(
                rowActionButtonClass,
                noteOpen ? "border-indigo-200 bg-indigo-50" : "",
              )}
            >
              <span className="sr-only">Show booking note</span>
              <StickyNote className="size-4" />
            </button>
            {noteOpen && noteLayout && typeof document !== "undefined"
              ? createPortal(
                  <div
                    ref={openNotePanelRef}
                    className={cn(
                      "fixed z-[90]",
                      noteLayout.placement === "top" ? "-translate-y-full" : "",
                    )}
                    style={{
                      left: noteLayout.left,
                      top: noteLayout.top,
                      width: noteLayout.width,
                    }}
                  >
                    <div className="relative rounded-2xl bg-foreground px-4 py-3 text-left text-sm leading-snug text-background shadow-2xl animate-in fade-in zoom-in-95 duration-200">
                      <span
                        aria-hidden="true"
                        className={cn(
                          "absolute size-3 rotate-45 bg-foreground",
                          noteLayout.placement === "top"
                            ? "top-full -translate-y-1/2"
                            : "bottom-full translate-y-1/2",
                        )}
                        style={{ left: noteLayout.arrowLeft }}
                      />
                      <div className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words">
                        {note}
                      </div>
                    </div>
                  </div>,
                  document.body,
                )
              : null}
          </div>
        ) : (
          <span className="size-8" aria-hidden="true" />
        )}
        {caps.canEditBookings ? (
          <button type="button" onClick={onEdit} className={rowActionButtonClass}>
            <span className="sr-only">Edit booking</span>
            <PencilLine className="size-4" />
          </button>
        ) : (
          <span className="size-8" aria-hidden="true" />
        )}
      </div>
      </div>
    </article>
  );
}

function CopiedBubble() {
  return (
    <div className="pointer-events-none absolute bottom-full left-1/2 z-30 -translate-x-1/2 pb-3">
      <span className="relative block rounded-2xl bg-foreground px-3 py-1.5 text-[10px] font-semibold text-background shadow-2xl animate-in fade-in zoom-in-95 duration-200">
        Copied
        <span
          aria-hidden="true"
          className="absolute left-1/2 top-full size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-foreground"
        />
      </span>
    </div>
  );
}

/**
 * Owner-only "mark as redeemed" toggle for Groupon bookings. Amber "Redeem" until
 * the owner has redeemed the voucher on Groupon, then a green "Redeemed" that can
 * be clicked to undo. Toggles `bookings.groupon_redeemed_at`.
 */
function GrouponRedeemButton({
  redeemed,
  busy,
  onToggle,
}: {
  redeemed: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={busy}
      aria-pressed={redeemed}
      title={
        redeemed
          ? "Redeemed on Groupon. Click to undo."
          : "Mark this Groupon voucher as redeemed."
      }
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        redeemed
          ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
          : "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100",
      )}
    >
      {redeemed ? (
        <TicketCheck className="size-4" />
      ) : (
        <Ticket className="size-4" />
      )}
      <span>{redeemed ? "Redeemed" : "Redeem"}</span>
    </button>
  );
}

// ── Edit modal ─────────────────────────────────────────────────────────────

const editInputClass =
  "h-9 w-full rounded-md border bg-background px-3 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50";
const editFieldClass = "grid gap-1 text-sm font-medium";

type PaxLine = {
  tier_id: string | null;
  label: string;
  qty: number;
  unit_price_cents: number;
  line_total_cents: number;
};

function EditBookingModal({
  booking,
  tours,
  role,
  caps,
  onClose,
  onSaved,
  onDeleted,
}: {
  booking: BookingRow;
  tours: TourOption[];
  role: "owner" | "business_manager" | "check_in";
  caps: BookingCaps;
  onClose: () => void;
  onSaved: (updated: BookingRow) => void;
  onDeleted: (id: string) => void;
}) {
  const [adult, setAdult] = useState(String(booking.pax_adult ?? 0));
  const [child, setChild] = useState(String(booking.pax_child ?? 0));
  const [infant, setInfant] = useState(String(booking.pax_infant ?? 0));
  const [status, setStatus] = useState<BookingStatus>(booking.status);
  const [date, setDate] = useState(toNyDateInput(booking.starts_at));
  const [time, setTime] = useState(toNyTimeInput(booking.starts_at));
  const [businessTourId, setBusinessTourId] = useState(booking.business_tour_id);
  const [notes, setNotes] = useState(booking.notes ?? "");
  const [fullName, setFullName] = useState(booking.customer?.full_name ?? "");
  const [email, setEmail] = useState(booking.customer?.email ?? "");

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const formRef = useRef<HTMLFormElement | null>(null);

  // Tours pickable for this booking: same business only.
  const businessTours = useMemo(
    () => tours.filter((t) => t.businessId === booking.business_id),
    [tours, booking.business_id],
  );

  const selectedTour = useMemo(
    () =>
      businessTours.find((t) => t.id === businessTourId) ??
      tours.find((t) => t.id === businessTourId) ??
      null,
    [businessTours, tours, businessTourId],
  );

  // Time choices come from the tour's configured timeslots only. The booking's
  // current time is always kept selectable so we never silently move it.
  const slotOptions = useMemo(() => {
    const set = new Set<string>();
    for (const s of selectedTour?.slots ?? []) set.add(normalizeHHMM(s.start_time));
    if (time) set.add(time);
    return [...set].sort();
  }, [selectedTour, time]);

  // When the user switches to a different tour, snap the time to that tour's
  // first slot (unless the current time is already one of its slots). On the
  // initial render (tour unchanged) we leave the existing time alone.
  useEffect(() => {
    if (businessTourId === booking.business_tour_id) return;
    const slots = (selectedTour?.slots ?? []).map((s) =>
      normalizeHHMM(s.start_time),
    );
    if (slots.length > 0 && !slots.includes(time)) setTime(slots[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessTourId]);

  const busy = saving || deleting;

  function readPhoneDigits(): string {
    const form = formRef.current;
    if (!form) return "";
    const field = form.elements.namedItem("customer_phone") as
      | (Element & { value?: string })
      | RadioNodeList
      | null;
    const value =
      field && "value" in field ? (field as { value?: string }).value : "";
    return String(value ?? "").replace(/\D/g, "");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    setSaving(true);
    setError(null);

    const a = toNonNegativeInteger(adult);
    const c = toNonNegativeInteger(child);
    const i = toNonNegativeInteger(infant);

    const safeDate = date || toNyDateInput(booking.starts_at);
    const safeTime = time || "00:00";
    const newStarts = nyLocalToUtcIso(safeDate, safeTime);

    // Preserve original duration; default to 60 minutes when invalid.
    let durationMs =
      new Date(booking.ends_at).getTime() -
      new Date(booking.starts_at).getTime();
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      durationMs = 60 * 60_000;
    }
    const newEnds = new Date(
      new Date(newStarts).getTime() + durationMs,
    ).toISOString();

    // Recompute totals + breakdown from the selected tour's tiers.
    const tierByLabel = new Map<string, TourOption["tiers"][number]>();
    for (const tier of selectedTour?.tiers ?? []) {
      tierByLabel.set(tier.label.toLowerCase(), tier);
    }

    const breakdown: PaxLine[] = [];
    let totalCents = 0;
    const addLine = (label: string, qty: number) => {
      if (qty <= 0) return;
      const tier = tierByLabel.get(label.toLowerCase());
      const unit = tier?.price_cents ?? 0;
      const lineTotal = qty * unit;
      totalCents += lineTotal;
      breakdown.push({
        tier_id: tier?.id ?? null,
        label: tier?.label ?? label,
        qty,
        unit_price_cents: unit,
        line_total_cents: lineTotal,
      });
    };
    addLine("adult", a);
    addLine("child", c);
    addLine("infant", i);

    const supabase = getSupabaseBrowserClient();
    const { error: bookingError } = await supabase
      .from("bookings")
      .update({
        business_tour_id: businessTourId,
        pax_adult: a,
        pax_child: c,
        pax_infant: i,
        starts_at: newStarts,
        ends_at: newEnds,
        status,
        notes: notes.trim() ? notes.trim() : null,
        total_cents: totalCents,
        tour_pax_breakdown: breakdown,
      })
      .eq("id", booking.id);

    if (bookingError) {
      setError(`Unable to update booking: ${bookingError.message}`);
      setSaving(false);
      return;
    }

    const trimmedName = fullName.trim();
    const phoneDigits = readPhoneDigits();
    const trimmedEmail = email.trim();
    let nextCustomerId = booking.customer_id;
    let nextCustomer = booking.customer;

    if (booking.customer_id) {
      const { error: custError } = await supabase
        .from("customers")
        .update({
          full_name: trimmedName,
          email: trimmedEmail || null,
          phone: phoneDigits || null,
        })
        .eq("id", booking.customer_id);
      if (custError) {
        setError(`Booking saved, but customer update failed: ${custError.message}`);
        setSaving(false);
        return;
      }
      nextCustomer = {
        id: booking.customer_id,
        full_name: trimmedName,
        email: trimmedEmail || null,
        phone: phoneDigits || null,
      };
    } else if (trimmedName) {
      const { data: inserted, error: insertError } = await supabase
        .from("customers")
        .insert({
          business_id: booking.business_id,
          full_name: trimmedName,
          email: trimmedEmail || null,
          phone: phoneDigits || null,
        })
        .select("id, full_name, phone, email")
        .single();
      if (insertError || !inserted) {
        setError(
          `Booking saved, but customer creation failed: ${insertError?.message ?? "unknown error"}`,
        );
        setSaving(false);
        return;
      }
      nextCustomerId = inserted.id;
      nextCustomer = inserted as BookingRow["customer"];

      const { error: linkError } = await supabase
        .from("bookings")
        .update({ customer_id: nextCustomerId })
        .eq("id", booking.id);
      if (linkError) {
        setError(`Booking saved, but customer link failed: ${linkError.message}`);
        setSaving(false);
        return;
      }
    }

    const updatedTour =
      tours.find((t) => t.id === businessTourId) ?? null;
    const updated: BookingRow = {
      ...booking,
      business_tour_id: businessTourId,
      pax_adult: a,
      pax_child: c,
      pax_infant: i,
      starts_at: newStarts,
      ends_at: newEnds,
      status,
      notes: notes.trim() ? notes.trim() : null,
      total_cents: totalCents,
      customer_id: nextCustomerId,
      customer: nextCustomer,
      business_tour: updatedTour
        ? {
            id: updatedTour.id,
            name: updatedTour.name,
            tour: {
              id: booking.business_tour?.tour?.id ?? "",
              name: updatedTour.masterTourName,
              capacity: updatedTour.capacity,
            },
          }
        : booking.business_tour,
    };

    setSaving(false);
    onSaved(updated);
  }

  async function handleDelete() {
    if (busy) return;
    const shouldDelete = window.confirm(
      `Delete booking ${booking.id.slice(0, 8).toUpperCase()}? This cannot be undone.`,
    );
    if (!shouldDelete) return;

    setDeleting(true);
    setError(null);

    const supabase = getSupabaseBrowserClient();
    const { error: deleteError } = await supabase
      .from("bookings")
      .delete()
      .eq("id", booking.id);

    if (deleteError) {
      setError(`Unable to delete booking: ${deleteError.message}`);
      setDeleting(false);
      return;
    }

    setDeleting(false);
    onDeleted(booking.id);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4 py-6 animate-in fade-in duration-200"
      role="presentation"
      onMouseDown={() => {
        if (!busy) onClose();
      }}
    >
      <form
        ref={formRef}
        aria-labelledby="booking-edit-title"
        aria-modal="true"
        className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border bg-card shadow-2xl animate-in fade-in zoom-in-95 slide-in-from-bottom-4 duration-300"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h2
            id="booking-edit-title"
            className="text-lg font-semibold tracking-tight"
          >
            Edit booking
          </h2>
          <button
            type="button"
            onClick={() => {
              if (!busy) onClose();
            }}
            aria-label="Close edit booking"
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="grid gap-6 overflow-y-auto px-5 py-4 lg:grid-cols-2">
          <section className="min-w-0">
            <h3 className="mb-3 text-base font-semibold">Booking information</h3>
            <div className="grid gap-2.5">
              <div className="flex flex-wrap items-end gap-2.5">
                <label className="grid w-16 gap-1 text-sm font-medium">
                  Adult
                  <input
                    type="number"
                    min="0"
                    value={adult}
                    disabled={busy}
                    onChange={(e) => setAdult(e.target.value)}
                    className="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-center text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
                  />
                </label>
                <label className="grid w-16 gap-1 text-sm font-medium">
                  Child
                  <input
                    type="number"
                    min="0"
                    value={child}
                    disabled={busy}
                    onChange={(e) => setChild(e.target.value)}
                    className="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-center text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
                  />
                </label>
                <label className="grid w-16 gap-1 text-sm font-medium">
                  Infant
                  <input
                    type="number"
                    min="0"
                    value={infant}
                    disabled={busy}
                    onChange={(e) => setInfant(e.target.value)}
                    className="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-center text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
                  />
                </label>
              </div>

              <label className={cn(editFieldClass, "max-w-xs")}>
                Status
                <select
                  value={status}
                  disabled={busy}
                  onChange={(e) => setStatus(e.target.value as BookingStatus)}
                  className={editInputClass}
                >
                  {STATUS_OPTIONS.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="grid max-w-xs gap-2.5 sm:grid-cols-[minmax(0,1fr)_9rem]">
                <label className={editFieldClass}>
                  Date
                  <DateField
                    required
                    value={date}
                    disabled={busy}
                    onChange={(e) => setDate(e.target.value)}
                    className={editInputClass}
                  />
                </label>
                <label className={editFieldClass}>
                  Time
                  <select
                    required
                    value={time}
                    disabled={busy || slotOptions.length === 0}
                    onChange={(e) => setTime(e.target.value)}
                    className={editInputClass}
                  >
                    {slotOptions.length === 0 ? (
                      <option value="">No timeslots</option>
                    ) : (
                      slotOptions.map((s) => (
                        <option key={s} value={s}>
                          {slotLabel(s)}
                        </option>
                      ))
                    )}
                  </select>
                </label>
              </div>

              <label className={cn(editFieldClass, "max-w-xs")}>
                Tour
                <select
                  required
                  value={businessTourId}
                  disabled={busy}
                  onChange={(e) => setBusinessTourId(e.target.value)}
                  className={editInputClass}
                >
                  {businessTours.length === 0 ? (
                    <option value={businessTourId}>
                      {booking.business_tour?.name ?? "(current tour)"}
                    </option>
                  ) : (
                    businessTours.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name || t.masterTourName || "Unnamed tour"}
                      </option>
                    ))
                  )}
                </select>
              </label>

              <label className={cn(editFieldClass, "max-w-sm")}>
                Notes
                <Textarea
                  value={notes}
                  disabled={busy}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </label>
            </div>
          </section>

          <section className="min-w-0">
            <h3 className="mb-3 text-base font-semibold">Customer</h3>
            <fieldset className="grid gap-2.5" disabled={busy}>
              <label className={cn(editFieldClass, "max-w-sm")}>
                Full name
                <input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className={editInputClass}
                />
              </label>

              <label className={cn(editFieldClass, "max-w-sm")}>
                Phone
                <PhoneInput
                  name="customer_phone"
                  defaultValue={booking.customer?.phone ?? ""}
                  className="h-9"
                />
              </label>

              <label className={cn(editFieldClass, "max-w-sm")}>
                Email
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={editInputClass}
                />
              </label>
            </fieldset>
          </section>
        </div>

        {error ? (
          <p className="mx-5 mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-3 border-t bg-muted/40 px-5 py-4">
          {caps.canDeleteBookings || role !== "check_in" ? (
            <div className="flex items-center gap-2">
              {caps.canDeleteBookings ? (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => void handleDelete()}
                  disabled={busy}
                >
                  {deleting ? "Deleting..." : "Delete"}
                </Button>
              ) : null}
              {role !== "check_in" ? (
                <PaymentLinkButton
                  bookingId={booking.id}
                  amountCents={booking.total_cents}
                  status={booking.status}
                  disabled={busy}
                />
              ) : null}
            </div>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                if (!busy) onClose();
              }}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <Card>
      <CardContent className="px-4 py-12">
        <div className="mx-auto flex max-w-md flex-col items-center gap-4 text-center">
          <div className="relative flex size-36 items-center justify-center">
            <span className="absolute bottom-3 h-8 w-28 rounded-full bg-muted blur-2xl" />
            <Ghost
              className="relative size-24 text-muted-foreground/35"
              strokeWidth={1.5}
            />
          </div>
          <div className="space-y-1">
            <p className="text-lg font-semibold tracking-tight">
              No bookings for this view
            </p>
            <p className="text-sm text-muted-foreground">
              Try another date or adjust the tour filter.
            </p>
          </div>
          <Link
            href="/schedule"
            className={cn(buttonVariants({ variant: "default" }))}
          >
            + Add booking
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
