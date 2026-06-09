"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { Search, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

/**
 * Global booking search. Lives in the sidebar (so it shows on every page that
 * renders the app shell) and also opens with Cmd/Ctrl+K. Results are whatever
 * the signed-in user is allowed to see, since the query runs through the
 * authenticated client and RLS scopes rows by role:
 *   owner            -> all businesses
 *   business_manager -> their business
 *   check_in         -> bookings on their assigned tours
 */

const TIMEZONE = "America/New_York";

type SearchResult = {
  id: string;
  startsAt: string;
  status: BookingStatus;
  customerName: string;
  customerPhone: string | null;
  tourName: string;
  pax: number;
};

type BookingStatus =
  | "pending"
  | "confirmed"
  | "checked_in"
  | "completed"
  | "cancelled";

// Confirmed bookings show no tag; only cancelled or unpaid get a badge.
function statusBadge(
  status: BookingStatus,
): { label: string; tone: "warning" | "danger" } | null {
  if (status === "cancelled") return { label: "Cancelled", tone: "danger" };
  if (status === "pending")
    return { label: "Waiting for payment", tone: "warning" };
  return null;
}

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE,
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** Returns YYYY-MM-DD for the given instant in the app timezone. */
function localDateOf(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function formatPhone(raw: string | null): string {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw;
}

function escapeLike(value: string): string {
  // Neutralize PostgREST or/ilike delimiters and LIKE wildcards.
  return value.replace(/[,()%_*]/g, " ").trim();
}

export function GlobalSearch() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const normalized = query.trim();

  // Cmd/Ctrl+K toggles the palette from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Reset transient state whenever the palette closes.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setError(null);
      setActiveIndex(0);
    }
  }, [open]);

  // Debounced search. Matches customers by name/phone/email, then loads their
  // bookings (newest first). RLS scopes everything to the caller.
  useEffect(() => {
    if (!open || normalized.length === 0) {
      setResults([]);
      setSearching(false);
      setError(null);
      return;
    }

    let cancelled = false;
    const handle = window.setTimeout(async () => {
      try {
        setSearching(true);
        setError(null);

        const supabase = getSupabaseBrowserClient();
        const text = escapeLike(normalized);
        const digits = normalized.replace(/\D/g, "");

        if (!text && !digits) {
          if (!cancelled) {
            setResults([]);
            setSearching(false);
          }
          return;
        }

        const filters: string[] = [];
        if (text) {
          filters.push(`full_name.ilike.%${text}%`);
          filters.push(`email.ilike.%${text}%`);
        }
        if (digits) {
          filters.push(`phone.ilike.%${digits}%`);
        }

        const { data: customers, error: custErr } = await supabase
          .from("customers")
          .select("id, full_name, phone")
          .or(filters.join(","))
          .limit(30);
        if (custErr) throw new Error(custErr.message);

        const customerIds = (customers ?? []).map((c) => c.id);
        if (customerIds.length === 0) {
          if (!cancelled) {
            setResults([]);
            setSearching(false);
            setActiveIndex(0);
          }
          return;
        }

        const { data: bookings, error: bookErr } = await supabase
          .from("bookings")
          .select(
            `id, starts_at, status, pax_adult, pax_child, pax_infant, customer_id,
             business_tour:business_tours!bookings_business_tour_id_fkey(name, tour:tours(name)),
             customer:customers!bookings_customer_id_fkey(id, full_name, phone)`,
          )
          .in("customer_id", customerIds)
          .order("starts_at", { ascending: false })
          .limit(25);
        if (bookErr) throw new Error(bookErr.message);

        const mapped: SearchResult[] = (
          (bookings ?? []) as unknown as RawBooking[]
        ).map((b) => ({
          id: b.id,
          startsAt: b.starts_at,
          status: b.status,
          customerName: b.customer?.full_name ?? "(walk-up)",
          customerPhone: b.customer?.phone ?? null,
          tourName:
            b.business_tour?.name ??
            b.business_tour?.tour?.name ??
            "(unknown tour)",
          pax:
            (b.pax_adult ?? 0) + (b.pax_child ?? 0) + (b.pax_infant ?? 0),
        }));

        if (!cancelled) {
          setResults(mapped);
          setActiveIndex(0);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Search failed.");
          setResults([]);
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [open, normalized]);

  const goToResult = useCallback(
    (result: SearchResult) => {
      setOpen(false);
      const date = localDateOf(result.startsAt);
      router.push(`/bookings?date=${date}&booking=${result.id}`);
    },
    [router],
  );

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = results[activeIndex];
      if (target) goToResult(target);
    }
  };

  const palette =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-4 py-[10vh] animate-in fade-in duration-200"
            role="dialog"
            aria-modal="true"
            aria-label="Search bookings"
            onMouseDown={() => setOpen(false)}
          >
            <section
              className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border bg-card shadow-2xl animate-in fade-in zoom-in-95 slide-in-from-top-2 duration-200"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-2 border-b px-4">
                <Search className="size-4 shrink-0 text-muted-foreground" />
                <input
                  ref={inputRef}
                  autoFocus
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onInputKeyDown}
                  placeholder="Search by name, phone, or email"
                  aria-label="Search bookings"
                  className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close search"
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {normalized.length === 0 ? (
                  <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                    Start typing to find a booking.
                  </p>
                ) : searching ? (
                  <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                    Searching...
                  </p>
                ) : error ? (
                  <p className="mx-1 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    {error}
                  </p>
                ) : results.length === 0 ? (
                  <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                    No bookings found.
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {results.map((r, i) => (
                      <li key={r.id}>
                        <button
                          type="button"
                          onMouseEnter={() => setActiveIndex(i)}
                          onClick={() => goToResult(r)}
                          className={cn(
                            "w-full rounded-lg px-3 py-2.5 text-left transition",
                            i === activeIndex
                              ? "bg-muted"
                              : "hover:bg-muted/60",
                          )}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <p className="truncate text-sm font-medium">
                              {r.customerName}
                            </p>
                            {(() => {
                              const badge = statusBadge(r.status);
                              return badge ? (
                                <Badge tone={badge.tone}>{badge.label}</Badge>
                              ) : null;
                            })()}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                            <span>{dateTimeFormatter.format(new Date(r.startsAt))}</span>
                            <span aria-hidden>·</span>
                            <span className="truncate">{r.tourName}</span>
                            {r.customerPhone && (
                              <>
                                <span aria-hidden>·</span>
                                <span>{formatPhone(r.customerPhone)}</span>
                              </>
                            )}
                            <span aria-hidden>·</span>
                            <span>
                              {r.pax} pax
                            </span>
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 w-full items-center gap-2 rounded-md border bg-background px-3 text-sm text-muted-foreground transition hover:bg-muted"
      >
        <Search className="size-4 shrink-0" />
        <span className="flex-1 truncate text-left">Search</span>
        <kbd className="pointer-events-none hidden rounded border bg-muted px-1.5 font-sans text-[10px] font-medium text-muted-foreground sm:inline-block">
          ⌘K
        </kbd>
      </button>
      {palette}
    </>
  );
}

type RawBooking = {
  id: string;
  starts_at: string;
  status: BookingStatus;
  pax_adult: number | null;
  pax_child: number | null;
  pax_infant: number | null;
  customer_id: string | null;
  business_tour: { name: string; tour: { name: string } | null } | null;
  customer: { id: string; full_name: string; phone: string | null } | null;
};
