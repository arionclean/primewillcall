"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { Search, X } from "lucide-react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

type GlobalSearchBarProps = {
  className?: string;
  companyId?: string;
};

type SearchBookingRow = {
  id: string;
  booking_reference: string | null;
  supplier: string | null;
  adult: number | null;
  child: number | null;
  infant: number | null;
  paxs: number | null;
  checked: boolean | null;
  date_timestamp: string;
  status: string | null;
  customer_id: string | null;
  product_id: string;
};

type SearchCustomerRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
};

type SearchProductRow = {
  id: string;
  product_name: string | null;
  short_name: string | null;
};

type SearchResult = {
  id: string;
  bookingReference: string;
  customerName: string;
  customerPhone: string;
  dateTimestamp: string;
  isChecked: boolean;
  paxCount: number;
  productName: string;
  supplier: string;
};

const resultDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const resultTimeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "UTC",
});

function getSearchPattern(value: string) {
  const sanitized = value.replace(/[,%]/g, " ").trim();
  return sanitized ? `%${sanitized}%` : "";
}

function getCustomerName(customer?: SearchCustomerRow) {
  if (!customer) {
    return "Unknown customer";
  }

  const name = `${customer.first_name ?? ""} ${customer.last_name ?? ""}`.trim();
  return name || "Unknown customer";
}

function getBookingPaxCount(booking: SearchBookingRow) {
  const explicitPax = Number(booking.adult ?? 0) + Number(booking.child ?? 0) + Number(booking.infant ?? 0);
  return explicitPax > 0 ? explicitPax : Number(booking.paxs ?? 0);
}

function formatResultDate(dateTimestamp: string) {
  const parsed = new Date(dateTimestamp);
  if (Number.isNaN(parsed.getTime())) {
    return "Unknown date";
  }

  return `${resultDateFormatter.format(parsed)} ${resultTimeFormatter.format(parsed)}`;
}

export default function GlobalSearchBar({ className, companyId }: GlobalSearchBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [value, setValue] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const normalizedValue = value.trim();

  useEffect(() => {
    if (!isOpen || !companyId || normalizedValue.length === 0) {
      setResults([]);
      setIsSearching(false);
      setSearchError(null);
      return;
    }

    let isCancelled = false;
    const searchPattern = getSearchPattern(normalizedValue);

    if (!searchPattern) {
      setResults([]);
      setIsSearching(false);
      setSearchError(null);
      return;
    }

    const searchTimeout = window.setTimeout(async () => {
      try {
        setIsSearching(true);
        setSearchError(null);

        const supabase = getSupabaseBrowserClient();
        const [customerResponse, productResponse, bookingResponse] = await Promise.all([
          supabase
            .from("customers")
            .select("id, first_name, last_name, phone, email")
            .eq("company_id", companyId)
            .or(
              `first_name.ilike.${searchPattern},last_name.ilike.${searchPattern},phone.ilike.${searchPattern},email.ilike.${searchPattern}`,
            )
            .limit(40),
          supabase
            .from("products")
            .select("id, product_name, short_name")
            .eq("company_id", companyId)
            .or(`product_name.ilike.${searchPattern},short_name.ilike.${searchPattern}`)
            .limit(40),
          supabase
            .from("bookings")
            .select(
              "id, booking_reference, supplier, adult, child, infant, paxs, checked, date_timestamp, status, customer_id, product_id",
            )
            .eq("company_id", companyId)
            .or(
              `booking_reference.ilike.${searchPattern},supplier.ilike.${searchPattern},status.ilike.${searchPattern},note.ilike.${searchPattern}`,
            )
            .order("date_timestamp", { ascending: false })
            .limit(30),
        ]);

        if (customerResponse.error) {
          throw new Error(customerResponse.error.message);
        }
        if (productResponse.error) {
          throw new Error(productResponse.error.message);
        }
        if (bookingResponse.error) {
          throw new Error(bookingResponse.error.message);
        }

        const matchedCustomers = (customerResponse.data ?? []) as SearchCustomerRow[];
        const matchedProducts = (productResponse.data ?? []) as SearchProductRow[];
        const directBookings = (bookingResponse.data ?? []) as SearchBookingRow[];
        const matchedCustomerIds = matchedCustomers.map((customer) => customer.id);
        const matchedProductIds = matchedProducts.map((product) => product.id);

        const relatedBookingResponses = await Promise.all([
          matchedCustomerIds.length > 0
            ? supabase
                .from("bookings")
                .select(
                  "id, booking_reference, supplier, adult, child, infant, paxs, checked, date_timestamp, status, customer_id, product_id",
                )
                .eq("company_id", companyId)
                .in("customer_id", matchedCustomerIds)
                .order("date_timestamp", { ascending: false })
                .limit(30)
            : null,
          matchedProductIds.length > 0
            ? supabase
                .from("bookings")
                .select(
                  "id, booking_reference, supplier, adult, child, infant, paxs, checked, date_timestamp, status, customer_id, product_id",
                )
                .eq("company_id", companyId)
                .in("product_id", matchedProductIds)
                .order("date_timestamp", { ascending: false })
                .limit(30)
            : null,
        ]);

        const relatedBookings = relatedBookingResponses.flatMap((response) => {
          if (!response) {
            return [];
          }
          if (response.error) {
            throw new Error(response.error.message);
          }
          return (response.data ?? []) as SearchBookingRow[];
        });

        const bookingById = new Map<string, SearchBookingRow>();
        for (const booking of [...directBookings, ...relatedBookings]) {
          bookingById.set(booking.id, booking);
        }

        const bookings = Array.from(bookingById.values())
          .sort((a, b) => new Date(b.date_timestamp).getTime() - new Date(a.date_timestamp).getTime())
          .slice(0, 12);

        const customerById = new Map(matchedCustomers.map((customer) => [customer.id, customer]));
        const productById = new Map(matchedProducts.map((product) => [product.id, product]));
        const missingCustomerIds = Array.from(
          new Set(
            bookings
              .map((booking) => booking.customer_id)
              .filter((customerId): customerId is string => {
                if (!customerId) {
                  return false;
                }
                return !customerById.has(customerId);
              }),
          ),
        );
        const missingProductIds = Array.from(
          new Set(
            bookings
              .map((booking) => booking.product_id)
              .filter((productId) => Boolean(productId) && !productById.has(productId)),
          ),
        );

        const [missingCustomerResponse, missingProductResponse] = await Promise.all([
          missingCustomerIds.length > 0
            ? supabase
                .from("customers")
                .select("id, first_name, last_name, phone, email")
                .eq("company_id", companyId)
                .in("id", missingCustomerIds)
            : null,
          missingProductIds.length > 0
            ? supabase
                .from("products")
                .select("id, product_name, short_name")
                .eq("company_id", companyId)
                .in("id", missingProductIds)
            : null,
        ]);

        if (missingCustomerResponse?.error) {
          throw new Error(missingCustomerResponse.error.message);
        }
        if (missingProductResponse?.error) {
          throw new Error(missingProductResponse.error.message);
        }

        for (const customer of ((missingCustomerResponse?.data ?? []) as SearchCustomerRow[])) {
          customerById.set(customer.id, customer);
        }
        for (const product of ((missingProductResponse?.data ?? []) as SearchProductRow[])) {
          productById.set(product.id, product);
        }

        if (!isCancelled) {
          setResults(
            bookings.map((booking) => {
              const customer = booking.customer_id ? customerById.get(booking.customer_id) : undefined;
              const product = productById.get(booking.product_id);

              return {
                id: booking.id,
                bookingReference: booking.booking_reference || "N/A",
                customerName: getCustomerName(customer),
                customerPhone: customer?.phone ?? "",
                dateTimestamp: booking.date_timestamp,
                isChecked: Boolean(booking.checked),
                paxCount: getBookingPaxCount(booking),
                productName: product?.product_name || product?.short_name || "Unknown product",
                supplier: booking.supplier || "N/A",
              };
            }),
          );
        }
      } catch (error) {
        if (!isCancelled) {
          setSearchError(error instanceof Error ? error.message : "Unable to search bookings.");
          setResults([]);
        }
      } finally {
        if (!isCancelled) {
          setIsSearching(false);
        }
      }
    }, 180);

    return () => {
      isCancelled = true;
      window.clearTimeout(searchTimeout);
    };
  }, [companyId, isOpen, normalizedValue]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen]);

  if (pathname === "/login") {
    return null;
  }

  const handleInput = (nextValue: string) => {
    setValue(nextValue);
  };

  const handleResultClick = (result: SearchResult) => {
    const parsed = new Date(result.dateTimestamp);
    const date = Number.isNaN(parsed.getTime())
      ? new Date().toISOString().slice(0, 10)
      : parsed.toISOString().slice(0, 10);

    setIsOpen(false);
    router.push(`/orders?date=${encodeURIComponent(date)}&booking=${encodeURIComponent(result.id)}`);
  };

  const searchPopup =
    isOpen && typeof document !== "undefined"
      ? createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4 py-6 animate-in fade-in duration-200"
          onClick={() => setIsOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Global search popup"
          >
            <section
            className="flex h-[min(82vh,42rem)] w-full max-w-xl flex-col overflow-hidden rounded-xl border bg-card shadow-2xl animate-in fade-in zoom-in-95 slide-in-from-bottom-4 duration-300"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b px-5 py-4">
              <p className="text-sm font-semibold">Global search</p>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                aria-label="Close search popup"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="px-5 py-4">
              <label className="relative block">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  autoFocus
                  type="text"
                  value={value}
                  onChange={(event) => handleInput(event.target.value)}
                  placeholder="Search bookings"
                  aria-label="Global search"
                  className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50"
                />
              </label>
            </div>
            <div className="flex min-h-0 flex-1 flex-col border-t bg-muted/30 px-5 py-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Results</p>
                {results.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {results.length} result{results.length === 1 ? "" : "s"}
                  </p>
                ) : null}
              </div>

              {!companyId ? (
                <p className="rounded-lg border bg-background px-3 py-3 text-sm text-muted-foreground">
                  Select a company to search bookings.
                </p>
              ) : normalizedValue.length === 0 ? (
                <p className="rounded-lg border bg-background px-3 py-3 text-sm text-muted-foreground">
                  Search by customer, phone, booking ID, product, supplier, or note.
                </p>
              ) : isSearching ? (
                <p className="rounded-lg border bg-background px-3 py-3 text-sm text-muted-foreground">
                  Searching bookings...
                </p>
              ) : searchError ? (
                <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-3 text-sm text-destructive">
                  {searchError}
                </p>
              ) : results.length === 0 ? (
                <p className="rounded-lg border bg-background px-3 py-3 text-sm text-muted-foreground">
                  No matching bookings found.
                </p>
              ) : (
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                  {results.map((result) => (
                    <button
                      key={result.id}
                      type="button"
                      onClick={() => handleResultClick(result)}
                      className="w-full rounded-lg border bg-background px-3 py-3 text-left transition hover:border-indigo-200 hover:bg-indigo-50/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">{result.customerName}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {formatResultDate(result.dateTimestamp)}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-sm font-semibold">{result.paxCount}</p>
                          <p className="text-xs text-muted-foreground">
                            {result.isChecked ? "Checked" : "Open"}
                          </p>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>{result.bookingReference}</span>
                        {result.customerPhone ? <span>{result.customerPhone}</span> : null}
                        <span>{result.supplier}</span>
                        <span>{result.productName}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>,
        document.body,
      )
      : null;

  return (
    <div className={cn("w-full", className)}>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="inline-flex h-9 w-full items-center rounded-md border bg-background px-3 text-sm text-muted-foreground transition hover:bg-muted"
      >
        <Search className="mr-2 size-4" />
        <span className="truncate">{value.trim() ? value : "Global search"}</span>
      </button>

      {searchPopup}
    </div>
  );
}
