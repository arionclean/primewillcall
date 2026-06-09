"use client";

import NextImage from "next/image";
import { FormEvent, ReactNode, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createPortal } from "react-dom";
import {
  CalendarPlus,
  Check,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  Filter,
  Ghost,
  Image as ImageIcon,
  LayoutDashboard,
  Monitor,
  Package,
  PencilLine,
  Receipt,
  Settings,
  StickyNote,
  X,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import GlobalSearchBar from "@/components/global-search-bar";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

type Company = {
  id: string;
  name: string | null;
  email: string | null;
};

type BookingRow = {
  id: string;
  booking_reference: string;
  supplier: string;
  adult: number;
  child: number;
  infant: number;
  paxs: number;
  checked: boolean;
  peek: boolean;
  date_timestamp: string;
  status: string;
  note: string;
  source_system: string | null;
  source_booking_id: string | null;
  photo_urls: string[];
  customer_id: string | null;
  product_id: string;
};

type Customer = {
  id: string;
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
};

type Product = {
  id: string;
  product_name: string;
  short_name: string;
  color: string;
};

type BookingEditForm = {
  bookingId: string;
  customerId: string | null;
  adult: string;
  child: string;
  infant: string;
  supplier: string;
  bookingReference: string;
  productId: string;
  date: string;
  time: string;
  status: string;
  note: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
};

type HoverTooltipProps = {
  label: string;
  children: ReactNode;
  className?: string;
  onlyWhenTruncated?: boolean;
};

type NotePopoverLayout = {
  arrowLeft: number;
  left: number;
  placement: "top" | "bottom";
  top: number;
  width: number;
};

const sidebarItems = [
  { label: "Overview", icon: LayoutDashboard, href: "/dashboard" },
  { label: "Bookings", icon: Receipt, href: "/orders", active: true },
  { label: "Schedule", icon: CalendarPlus, href: "/schedule" },
  { label: "Products", icon: Package, href: "/products" },
  { label: "Kiosks", icon: Monitor, href: "/kiosks" },
  { label: "Team", icon: Users, href: "/team" },
  { label: "Settings", icon: Settings, href: "#" },
];

const dateLabelFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const timeLabelFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "UTC",
});

function resolveRowColor(rawColor?: string) {
  const trimmed = rawColor?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.toLowerCase().replace(/\s+/g, "");
  if (normalized === "nocolor") {
    return null;
  }

  return trimmed;
}

function toSoftRowColor(rawColor?: string) {
  const resolved = resolveRowColor(rawColor);
  if (!resolved) {
    return null;
  }
  return `color-mix(in srgb, ${resolved} 14%, white)`;
}

function getBookingPaxCount(booking: BookingRow) {
  if (booking.adult > 0 || booking.child > 0 || booking.infant > 0) {
    return booking.adult + booking.child + booking.infant;
  }
  return booking.paxs;
}

function toDateInputValue(dateTimestamp: string) {
  const parsed = new Date(dateTimestamp);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  return parsed.toISOString().slice(0, 10);
}

function isDateInputValue(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  return !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}

function toTimeInputValue(dateTimestamp: string) {
  const parsed = new Date(dateTimestamp);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  return parsed.toISOString().slice(11, 16);
}

function toNonNegativeInteger(value: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function buildEditForm(booking: BookingRow, customer?: Customer): BookingEditForm {
  return {
    bookingId: booking.id,
    customerId: booking.customer_id,
    adult: String(
      booking.adult > 0 || booking.child > 0 || booking.infant > 0 ? booking.adult : booking.paxs,
    ),
    child: String(booking.child),
    infant: String(booking.infant),
    supplier: booking.supplier,
    bookingReference: booking.booking_reference,
    productId: booking.product_id,
    date: toDateInputValue(booking.date_timestamp),
    time: toTimeInputValue(booking.date_timestamp),
    status: booking.status,
    note: booking.note,
    firstName: customer?.first_name ?? "",
    lastName: customer?.last_name ?? "",
    phone: customer?.phone ?? "",
    email: customer?.email ?? "",
  };
}

function getEditFormSignature(form: BookingEditForm) {
  return JSON.stringify({
    bookingId: form.bookingId,
    customerId: form.customerId ?? null,
    adult: toNonNegativeInteger(form.adult),
    child: toNonNegativeInteger(form.child),
    infant: toNonNegativeInteger(form.infant),
    supplier: form.supplier.trim(),
    bookingReference: form.bookingReference.trim(),
    productId: form.productId,
    date: form.date,
    time: form.time,
    status: form.status.trim(),
    note: form.note.trim(),
    firstName: form.firstName.trim(),
    lastName: form.lastName.trim(),
    phone: form.phone.trim(),
    email: form.email.trim(),
  });
}

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
      rect.top < 96 && window.innerHeight - rect.bottom > rect.top ? "bottom" : "top";
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
        target.scrollWidth - target.clientWidth > 1 || target.scrollHeight - target.clientHeight > 1;
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

function parseImageUrls(value: unknown) {
  const normalize = (input: string) => input.replace(/\u00a0/g, " ").trim();

  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map(normalize)
      .filter(Boolean);
  }

  if (typeof value !== "string") {
    return [];
  }

  const normalizedValue = normalize(value);
  if (!normalizedValue || normalizedValue === "[]") {
    return [];
  }

  try {
    const parsed = JSON.parse(normalizedValue);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((entry): entry is string => typeof entry === "string")
        .map(normalize)
        .filter(Boolean);
    }
  } catch {
    return normalizedValue
      .split(",")
      .map(normalize)
      .filter((entry) => entry.startsWith("http://") || entry.startsWith("https://"));
  }

  return [];
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

function OrdersContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dateParam = searchParams.get("date")?.trim() ?? "";
  const focusedBookingId = searchParams.get("booking")?.trim() ?? "";
  const [isLoading, setIsLoading] = useState(true);
  const [isDataLoading, setIsDataLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [draftSelectedProductIds, setDraftSelectedProductIds] = useState<string[]>([]);
  const [isProductFilterOpen, setIsProductFilterOpen] = useState(false);
  const [updatingCheckedIds, setUpdatingCheckedIds] = useState<string[]>([]);
  const [updatingPeekIds, setUpdatingPeekIds] = useState<string[]>([]);
  const [editForm, setEditForm] = useState<BookingEditForm | null>(null);
  const [editBaseline, setEditBaseline] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [isEditSaving, setIsEditSaving] = useState(false);
  const [isEditDeleting, setIsEditDeleting] = useState(false);
  const [copiedFieldKey, setCopiedFieldKey] = useState<string | null>(null);
  const [openNoteBookingId, setOpenNoteBookingId] = useState<string | null>(null);
  const [openNoteLayout, setOpenNoteLayout] = useState<NotePopoverLayout | null>(null);
  const [openPhotoBooking, setOpenPhotoBooking] = useState<BookingRow | null>(null);
  const [activePhotoIndex, setActivePhotoIndex] = useState(0);
  const [privacyMode, setPrivacyMode] = useState(false);
  const openNoteContainerRef = useRef<HTMLDivElement | null>(null);
  const openNotePanelRef = useRef<HTMLDivElement | null>(null);
  const openNoteTriggerRef = useRef<HTMLElement | null>(null);
  const [selectedDate, setSelectedDate] = useState(() => {
    if (isDateInputValue(dateParam)) {
      return dateParam;
    }

    const now = new Date();
    const localDate = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return localDate.toISOString().slice(0, 10);
  });
  const [highlightedBookingId, setHighlightedBookingId] = useState<string | null>(null);
  const query = searchParams.get("q")?.trim().toLowerCase() ?? "";

  useEffect(() => {
    if (isDateInputValue(dateParam) && dateParam !== selectedDate) {
      setSelectedDate(dateParam);
    }
  }, [dateParam, selectedDate]);

  useEffect(() => {
    if (!focusedBookingId) {
      return;
    }

    setSelectedProductIds([]);
    setDraftSelectedProductIds([]);
  }, [focusedBookingId]);

  useEffect(() => {
    const load = async () => {
      try {
        const supabase = getSupabaseBrowserClient();
        const { data: sessionData } = await supabase.auth.getSession();

        if (!sessionData.session) {
          router.replace("/login");
          return;
        }

        const userId = sessionData.session.user.id;
        const { data: companyRows, error: companyError } = await supabase
          .from("companies")
          .select("id, name, email")
          .eq("user_id", userId)
          .order("created_at", { ascending: true });

        if (companyError) {
          throw new Error(companyError.message);
        }

        const safeCompanies = (companyRows ?? []) as Company[];
        setCompanies(safeCompanies);
        if (safeCompanies.length > 0) {
          setSelectedCompanyId(safeCompanies[0].id);
        }
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Unable to load orders.");
      } finally {
        setIsLoading(false);
      }
    };

    void load();
  }, [router]);

  useEffect(() => {
    if (!selectedCompanyId) {
      setBookings([]);
      setCustomers([]);
      setProducts([]);
      setSelectedProductIds([]);
      setDraftSelectedProductIds([]);
      setIsProductFilterOpen(false);
      return;
    }

    let cancelled = false;

    const loadData = async () => {
      try {
        setIsDataLoading(true);
        setError(null);

        const supabase = getSupabaseBrowserClient();
        const [{ data: bookingRows, error: bookingError }, { data: customerRows, error: customerError }, { data: productRows, error: productError }] = await Promise.all([
          supabase
            .from("bookings")
            .select(
              "id, booking_reference, supplier, adult, child, infant, paxs, checked, peek, date_timestamp, status, note, source_system, source_booking_id, customer_id, product_id",
            )
            .eq("company_id", selectedCompanyId)
            .order("date_timestamp", { ascending: true }),
          supabase
            .from("customers")
            .select("id, first_name, last_name, phone, email")
            .eq("company_id", selectedCompanyId),
          supabase
            .from("products")
            .select("id, product_name, short_name, color")
            .eq("company_id", selectedCompanyId),
        ]);

        if (bookingError) {
          throw new Error(bookingError.message);
        }
        if (customerError) {
          throw new Error(customerError.message);
        }
        if (productError) {
          throw new Error(productError.message);
        }

        if (cancelled) {
          return;
        }

        const safeBookings = ((bookingRows ?? []) as Array<{
          id: string;
          booking_reference: string | null;
          supplier: string | null;
          adult: number | null;
          child: number | null;
          infant: number | null;
          paxs: number | null;
          checked: boolean | null;
          peek: boolean | null;
          date_timestamp: string;
          status: string | null;
          note: string | null;
          source_system: string | null;
          source_booking_id: string | null;
          customer_id: string | null;
          product_id: string;
        }>).map((row) => ({
          id: row.id,
          booking_reference: row.booking_reference ?? "N/A",
          supplier: row.supplier ?? "N/A",
          adult: Number(row.adult ?? 0),
          child: Number(row.child ?? 0),
          infant: Number(row.infant ?? 0),
          paxs: Number(row.paxs ?? 0),
          checked: Boolean(row.checked),
          peek: Boolean(row.peek),
          date_timestamp: row.date_timestamp,
          status: row.status ?? "unknown",
          note: row.note ?? "",
          source_system: row.source_system,
          source_booking_id: row.source_booking_id,
          photo_urls: [],
          customer_id: row.customer_id,
          product_id: row.product_id,
        }));

        const sourceBookingIds = Array.from(
          new Set(
            safeBookings
              .map((booking) => booking.source_booking_id?.trim())
              .filter((value): value is string => Boolean(value)),
          ),
        );

        let photoUrlsBySourceBookingId = new Map<string, string[]>();

        if (sourceBookingIds.length > 0) {
          const { data: mediaRows, error: mediaError } = await supabase
            .from("stg_bookings_raw")
            .select("old_booking_id, raw_record")
            .eq("company_id", selectedCompanyId)
            .in("old_booking_id", sourceBookingIds);

          if (mediaError) {
            throw new Error(mediaError.message);
          }

          photoUrlsBySourceBookingId = new Map(
            ((mediaRows ?? []) as Array<{
              old_booking_id: string | null;
              raw_record: { image_url?: unknown } | null;
            }>)
              .map((row) => [
                row.old_booking_id ?? "",
                parseImageUrls(row.raw_record?.image_url),
              ] as const)
              .filter(([oldBookingId]) => Boolean(oldBookingId)),
          );
        }

        setBookings(
          safeBookings.map((booking) => ({
            ...booking,
            photo_urls: booking.source_booking_id
              ? photoUrlsBySourceBookingId.get(booking.source_booking_id) ?? []
              : [],
          })),
        );
        setCustomers((customerRows ?? []) as Customer[]);
        setProducts((productRows ?? []) as Product[]);
        setSelectedProductIds([]);
        setDraftSelectedProductIds([]);
        setIsProductFilterOpen(false);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Unable to load orders.");
        }
      } finally {
        if (!cancelled) {
          setIsDataLoading(false);
        }
      }
    };

    void loadData();

    return () => {
      cancelled = true;
    };
  }, [selectedCompanyId]);

  const customerById = useMemo(() => {
    const map = new Map<string, Customer>();
    for (const customer of customers) {
      map.set(customer.id, customer);
    }
    return map;
  }, [customers]);

  const productById = useMemo(() => {
    const map = new Map<string, Product>();
    for (const product of products) {
      map.set(product.id, product);
    }
    return map;
  }, [products]);

  const selectedProductSet = useMemo(() => new Set(selectedProductIds), [selectedProductIds]);

  const productFilterLabel = useMemo(() => {
    if (products.length === 0) {
      return "No Products";
    }

    if (selectedProductIds.length === 0) {
      return "All Products";
    }

    if (selectedProductIds.length === 1) {
      const product = productById.get(selectedProductIds[0]);
      return product?.short_name || product?.product_name || "Selected Product";
    }

    return `${selectedProductIds.length} Products`;
  }, [productById, products.length, selectedProductIds]);

  const statusOptions = useMemo(() => {
    const statuses = new Set(["confirmed", "pending", "cancelled", "unknown"]);
    for (const booking of bookings) {
      if (booking.status) {
        statuses.add(booking.status);
      }
    }
    return Array.from(statuses).sort();
  }, [bookings]);

  const activePhotoUrl = useMemo(() => {
    if (!openPhotoBooking) {
      return null;
    }

    return openPhotoBooking.photo_urls[activePhotoIndex] ?? openPhotoBooking.photo_urls[0] ?? null;
  }, [activePhotoIndex, openPhotoBooking]);

  const dayBookings = useMemo(() => {
    return bookings.filter((booking) => {
      const parsed = new Date(booking.date_timestamp);
      if (Number.isNaN(parsed.getTime())) {
        return false;
      }
      return parsed.toISOString().slice(0, 10) === selectedDate;
    });
  }, [bookings, selectedDate]);

  const filteredDayBookings = useMemo(() => {
    const productFilteredBookings =
      selectedProductIds.length === 0
        ? dayBookings
        : dayBookings.filter((booking) => selectedProductSet.has(booking.product_id));

    if (!query) {
      return productFilteredBookings;
    }

    return productFilteredBookings.filter((booking) => {
      const customer = booking.customer_id ? customerById.get(booking.customer_id) : undefined;
      const customerName = customer
        ? `${customer.first_name} ${customer.last_name}`.trim()
        : "Unknown customer";
      const customerPhone = customer?.phone ?? "";
      const product = productById.get(booking.product_id);
      const productName = product?.product_name || product?.short_name || "Unknown product";

      return (
        booking.booking_reference.toLowerCase().includes(query) ||
        booking.supplier.toLowerCase().includes(query) ||
        customerName.toLowerCase().includes(query) ||
        customerPhone.toLowerCase().includes(query) ||
        productName.toLowerCase().includes(query)
      );
    });
  }, [customerById, dayBookings, productById, query, selectedProductIds.length, selectedProductSet]);

  useEffect(() => {
    if (!focusedBookingId) {
      setHighlightedBookingId(null);
      return;
    }

    if (isDataLoading || !filteredDayBookings.some((booking) => booking.id === focusedBookingId)) {
      return;
    }

    let clearHighlightTimer: number | undefined;
    const animationFrame = window.requestAnimationFrame(() => {
      const bookingRow = document.getElementById(`booking-${focusedBookingId}`);
      bookingRow?.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlightedBookingId(focusedBookingId);

      const nextParams = new URLSearchParams(window.location.search);
      nextParams.delete("booking");
      const nextQuery = nextParams.toString();
      const nextUrl = nextQuery ? `${window.location.pathname}?${nextQuery}` : window.location.pathname;
      window.history.replaceState(null, "", nextUrl);

      clearHighlightTimer = window.setTimeout(() => {
        setHighlightedBookingId((current) => (current === focusedBookingId ? null : current));
      }, 3000);
    });

    return () => {
      window.cancelAnimationFrame(animationFrame);
      if (clearHighlightTimer) {
        window.clearTimeout(clearHighlightTimer);
      }
    };
  }, [filteredDayBookings, focusedBookingId, isDataLoading]);

  const selectedDateLabel = useMemo(() => {
    const parsed = new Date(`${selectedDate}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      return selectedDate;
    }
    return dateLabelFormatter.format(parsed);
  }, [selectedDate]);

  const groupedBookings = useMemo(() => {
    const grouped = new Map<string, { rows: BookingRow[]; totalPax: number; checkedPax: number }>();

    for (const booking of filteredDayBookings) {
      const parsed = new Date(booking.date_timestamp);
      if (Number.isNaN(parsed.getTime())) {
        continue;
      }

      const slotKey = parsed.toISOString().slice(11, 16);
      const current = grouped.get(slotKey) ?? { rows: [], totalPax: 0, checkedPax: 0 };
      const paxCount = getBookingPaxCount(booking);
      current.rows.push(booking);
      current.totalPax += paxCount;
      if (booking.checked) {
        current.checkedPax += paxCount;
      }
      grouped.set(slotKey, current);
    }

    return Array.from(grouped.entries())
      .sort(([slotA], [slotB]) => slotA.localeCompare(slotB))
      .map(([slotKey, metrics]) => {
        const parsed = new Date(`${selectedDate}T${slotKey}:00Z`);
        const slotLabel = Number.isNaN(parsed.getTime())
          ? `${selectedDateLabel} ${slotKey}`
          : `${selectedDateLabel} ${timeLabelFormatter.format(parsed)}`;

        return {
          slotKey,
          slotLabel,
          rows: metrics.rows,
          totalPax: metrics.totalPax,
          checkedPax: metrics.checkedPax,
        };
      });
  }, [filteredDayBookings, selectedDate, selectedDateLabel]);

  const handleSignOut = async () => {
    const supabase = getSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  };

  const handleToggleChecked = async (bookingId: string, currentValue: boolean) => {
    const nextValue = !currentValue;
    setUpdatingCheckedIds((current) =>
      current.includes(bookingId) ? current : [...current, bookingId],
    );
    setBookings((current) =>
      current.map((booking) =>
        booking.id === bookingId ? { ...booking, checked: nextValue } : booking,
      ),
    );

    const supabase = getSupabaseBrowserClient();
    const { error: updateError } = await supabase
      .from("bookings")
      .update({ checked: nextValue })
      .eq("id", bookingId)
      .eq("company_id", selectedCompanyId);

    if (updateError) {
      setBookings((current) =>
        current.map((booking) =>
          booking.id === bookingId ? { ...booking, checked: currentValue } : booking,
        ),
      );
      setError(`Unable to update checked status: ${updateError.message}`);
    }

    setUpdatingCheckedIds((current) => current.filter((id) => id !== bookingId));
  };

  const handleTogglePeek = async (bookingId: string, currentValue: boolean) => {
    const nextValue = !currentValue;
    setUpdatingPeekIds((current) =>
      current.includes(bookingId) ? current : [...current, bookingId],
    );
    setBookings((current) =>
      current.map((booking) =>
        booking.id === bookingId ? { ...booking, peek: nextValue } : booking,
      ),
    );

    const supabase = getSupabaseBrowserClient();
    const { error: updateError } = await supabase
      .from("bookings")
      .update({ peek: nextValue })
      .eq("id", bookingId)
      .eq("company_id", selectedCompanyId);

    if (updateError) {
      setBookings((current) =>
        current.map((booking) =>
          booking.id === bookingId ? { ...booking, peek: currentValue } : booking,
        ),
      );
      setError(`Unable to update Peek status: ${updateError.message}`);
    }

    setUpdatingPeekIds((current) => current.filter((id) => id !== bookingId));
  };

  const handleCopyField = async (fieldKey: string, value: string, errorMessage: string) => {
    if (await copyTextToClipboard(value)) {
      setCopiedFieldKey(fieldKey);
      window.setTimeout(() => {
        setCopiedFieldKey((current) => (current === fieldKey ? null : current));
      }, 1400);
      return;
    }

    setError(errorMessage);
  };

  const openProductFilter = () => {
    setDraftSelectedProductIds(selectedProductIds);
    setIsProductFilterOpen(true);
  };

  const applyProductFilter = () => {
    setSelectedProductIds(draftSelectedProductIds);
    setIsProductFilterOpen(false);
  };

  const toggleDraftProduct = (productId: string) => {
    setDraftSelectedProductIds((current) => {
      if (current.length === 0) {
        return [productId];
      }

      const nextSelection = current.includes(productId)
        ? current.filter((id) => id !== productId)
        : [...current, productId];

      if (nextSelection.length === 0 || nextSelection.length === products.length) {
        return [];
      }

      return nextSelection;
    });
  };

  const openEditBooking = (booking: BookingRow) => {
    const customer = booking.customer_id ? customerById.get(booking.customer_id) : undefined;
    const nextEditForm = buildEditForm(booking, customer);

    setEditError(null);
    setEditBaseline(getEditFormSignature(nextEditForm));
    setEditForm(nextEditForm);
  };

  const closeEditBooking = () => {
    if (isEditSaving || isEditDeleting) {
      return;
    }

    setEditForm(null);
    setEditBaseline(null);
    setEditError(null);
  };

  const openPhotoGallery = (booking: BookingRow) => {
    setOpenNoteBookingId(null);
    setOpenNoteLayout(null);
    openNoteTriggerRef.current = null;
    setActivePhotoIndex(0);
    setOpenPhotoBooking(booking);
  };

  const closePhotoGallery = () => {
    setOpenPhotoBooking(null);
    setActivePhotoIndex(0);
  };

  const updateEditForm = (field: keyof BookingEditForm, value: string) => {
    setEditForm((current) => (current ? { ...current, [field]: value } : current));
  };

  const updateNotePlacement = (trigger: HTMLElement | null) => {
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
  };

  const isEditDirty = useMemo(() => {
    if (!editForm || !editBaseline) {
      return false;
    }

    return getEditFormSignature(editForm) !== editBaseline;
  }, [editBaseline, editForm]);

  const handleSaveBookingEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!editForm || !isEditDirty) {
      return;
    }

    const adult = toNonNegativeInteger(editForm.adult);
    const child = toNonNegativeInteger(editForm.child);
    const infant = toNonNegativeInteger(editForm.infant);
    const date = editForm.date || selectedDate;
    const time = editForm.time || "00:00";
    const dateTimestamp = new Date(`${date}T${time}:00Z`).toISOString();
    const nextPaxs = adult + child + infant;
    const trimmedFirstName = editForm.firstName.trim();
    const trimmedLastName = editForm.lastName.trim();
    const trimmedPhone = editForm.phone.trim();
    const trimmedEmail = editForm.email.trim();
    const hasCustomerDetails =
      Boolean(trimmedFirstName) ||
      Boolean(trimmedLastName) ||
      Boolean(trimmedPhone) ||
      Boolean(trimmedEmail);

    setIsEditSaving(true);
    setEditError(null);

    const supabase = getSupabaseBrowserClient();
    const { error: bookingError } = await supabase
      .from("bookings")
      .update({
        adult,
        child,
        infant,
        paxs: nextPaxs,
        supplier: editForm.supplier.trim(),
        booking_reference: editForm.bookingReference.trim(),
        product_id: editForm.productId,
        date_timestamp: dateTimestamp,
        status: editForm.status.trim(),
        note: editForm.note.trim(),
      })
      .eq("id", editForm.bookingId)
      .eq("company_id", selectedCompanyId);

    if (bookingError) {
      setEditError(`Unable to update booking: ${bookingError.message}`);
      setIsEditSaving(false);
      return;
    }

    let nextCustomerId = editForm.customerId;

    if (editForm.customerId) {
      const { error: customerError } = await supabase
        .from("customers")
        .update({
          first_name: trimmedFirstName,
          last_name: trimmedLastName,
          phone: trimmedPhone,
          email: trimmedEmail,
        })
        .eq("id", editForm.customerId)
        .eq("company_id", selectedCompanyId);

      if (customerError) {
        setEditError(`Booking saved, but customer update failed: ${customerError.message}`);
        setIsEditSaving(false);
        return;
      }
    } else if (hasCustomerDetails) {
      const { data: insertedCustomer, error: customerInsertError } = await supabase
        .from("customers")
        .insert({
          company_id: selectedCompanyId,
          first_name: trimmedFirstName,
          last_name: trimmedLastName,
          phone: trimmedPhone,
          email: trimmedEmail,
        })
        .select("id, first_name, last_name, phone, email")
        .single();

      if (customerInsertError) {
        setEditError(`Booking saved, but customer creation failed: ${customerInsertError.message}`);
        setIsEditSaving(false);
        return;
      }

      nextCustomerId = insertedCustomer.id;

      const { error: bookingCustomerError } = await supabase
        .from("bookings")
        .update({ customer_id: nextCustomerId })
        .eq("id", editForm.bookingId)
        .eq("company_id", selectedCompanyId);

      if (bookingCustomerError) {
        setEditError(`Booking saved, but customer link failed: ${bookingCustomerError.message}`);
        setIsEditSaving(false);
        return;
      }

      setCustomers((current) => [...current, insertedCustomer as Customer]);
    }

    setBookings((current) =>
      current.map((booking) =>
        booking.id === editForm.bookingId
          ? {
              ...booking,
              adult,
              child,
              infant,
              paxs: nextPaxs,
              supplier: editForm.supplier.trim(),
              booking_reference: editForm.bookingReference.trim(),
              product_id: editForm.productId,
              date_timestamp: dateTimestamp,
              status: editForm.status.trim(),
              note: editForm.note.trim(),
              customer_id: nextCustomerId,
            }
          : booking,
      ),
    );

    if (editForm.customerId) {
      setCustomers((current) =>
        current.map((customer) =>
          customer.id === editForm.customerId
            ? {
                ...customer,
                first_name: trimmedFirstName,
                last_name: trimmedLastName,
                phone: trimmedPhone,
                email: trimmedEmail,
              }
            : customer,
        ),
      );
    }

    setIsEditSaving(false);
    setEditForm(null);
    setEditBaseline(null);
  };

  const handleDeleteBooking = async () => {
    if (!editForm || isEditSaving || isEditDeleting) {
      return;
    }

    const shouldDelete = window.confirm(
      `Delete booking ${editForm.bookingReference || editForm.bookingId}? This cannot be undone.`,
    );

    if (!shouldDelete) {
      return;
    }

    setIsEditDeleting(true);
    setEditError(null);

    const supabase = getSupabaseBrowserClient();
    const { error: deleteError } = await supabase
      .from("bookings")
      .delete()
      .eq("id", editForm.bookingId)
      .eq("company_id", selectedCompanyId);

    if (deleteError) {
      setEditError(`Unable to delete booking: ${deleteError.message}`);
      setIsEditDeleting(false);
      return;
    }

    setBookings((current) => current.filter((booking) => booking.id !== editForm.bookingId));
    setOpenNoteBookingId((current) => (current === editForm.bookingId ? null : current));
    if (openNoteBookingId === editForm.bookingId) {
      setOpenNoteLayout(null);
      openNoteTriggerRef.current = null;
    }
    setOpenPhotoBooking((current) => (current?.id === editForm.bookingId ? null : current));
    setIsEditDeleting(false);
    setEditForm(null);
    setEditBaseline(null);
  };

  const rowActionButtonClass =
    "inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-transparent text-indigo-500 transition hover:border-indigo-200 hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
  const editInputClass =
    "h-9 w-full rounded-md border bg-background px-3 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50";
  const editTextareaClass =
    "min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50";
  const editFieldClass = "grid gap-1 text-sm font-medium";

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
  }, [openNoteBookingId]);

  if (isLoading) {
    return (
      <main className="min-h-screen bg-gradient-to-b from-background via-background to-muted/40">
        <section className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-6">
          <p className="text-sm text-muted-foreground">Loading bookings...</p>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-background via-background to-muted/40">
      <section className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:py-8">
        <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
          <aside className="hidden rounded-xl border bg-card p-4 lg:sticky lg:top-6 lg:block lg:h-[calc(100vh-4rem)]">
            <div className="mb-4">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Prime</p>
              <h2 className="mt-1 text-lg font-semibold">Dashboard</h2>
            </div>

            <nav className="space-y-1">
              {sidebarItems.map((item) => {
                const Icon = item.icon;

                return (
                  <Link
                    key={item.label}
                    href={item.href}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                      item.active
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <Icon className="size-4" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>

            <div className="mt-6 rounded-lg border bg-background p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Search</p>
              <div className="mt-2">
                <GlobalSearchBar companyId={selectedCompanyId} />
              </div>
            </div>

            <div className="mt-6 rounded-lg border bg-background p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Company</p>
              <select
                value={selectedCompanyId}
                onChange={(event) => setSelectedCompanyId(event.target.value)}
                className="mt-2 h-9 w-full rounded-md border bg-background px-2 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {companies.length === 0 ? (
                  <option value="">No companies found</option>
                ) : (
                  companies.map((company) => (
                    <option key={company.id} value={company.id}>
                      {company.name ?? company.email ?? "Unnamed company"}
                    </option>
                  ))
                )}
              </select>
            </div>

            <div className="mt-6">
              <Button variant="outline" onClick={handleSignOut} className="w-full">
                Sign out
              </Button>
            </div>
          </aside>

          <div>
            <div className="mb-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] lg:hidden">
              <select
                value={selectedCompanyId}
                onChange={(event) => setSelectedCompanyId(event.target.value)}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                {companies.length === 0 ? (
                  <option value="">No companies found</option>
                ) : (
                  companies.map((company) => (
                    <option key={company.id} value={company.id}>
                      {company.name ?? company.email ?? "Unnamed company"}
                    </option>
                  ))
                )}
              </select>
              <Button variant="outline" onClick={handleSignOut} className="h-9">
                Sign out
              </Button>
            </div>
            <div className="mb-3 lg:hidden">
              <GlobalSearchBar companyId={selectedCompanyId} />
            </div>

            {error ? (
              <p className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}

            <div className="mb-3 grid gap-2 sm:max-w-[700px] sm:grid-cols-3">
              <div className="rounded-xl border bg-card p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Date</p>
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(event) => setSelectedDate(event.target.value)}
                  className="mt-1.5 h-9 w-full rounded-md border bg-background px-2 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50"
                />
              </div>
              <div className="rounded-xl border bg-card p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Product</p>
                <button
                  type="button"
                  onClick={openProductFilter}
                  disabled={products.length === 0 || isDataLoading}
                  aria-haspopup="dialog"
                  aria-expanded={isProductFilterOpen}
                  className="mt-1.5 inline-flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 text-sm text-foreground/80 transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Filter className="size-4 shrink-0 text-indigo-500" />
                    <span className="truncate">{productFilterLabel}</span>
                  </span>
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                </button>
              </div>
              <div className="rounded-xl border bg-card p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Privacy</p>
                <button
                  type="button"
                  onClick={() => setPrivacyMode((current) => !current)}
                  className="mt-1.5 inline-flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 text-sm text-foreground/80 transition hover:bg-muted"
                >
                  <span>Privacy mode</span>
                  {privacyMode ? (
                    <EyeOff className="size-5 text-indigo-500" />
                  ) : (
                    <Eye className="size-5 text-indigo-500" />
                  )}
                </button>
              </div>
            </div>

            <section className="relative rounded-xl bg-card">
              {isDataLoading ? (
                <div className="px-4 py-8 text-sm text-muted-foreground">Loading bookings list...</div>
              ) : filteredDayBookings.length === 0 ? (
                <div className="px-4 py-12">
                  <div className="mx-auto flex max-w-md flex-col items-center gap-4 text-center">
                    <div className="relative flex size-36 items-center justify-center">
                      <span className="absolute bottom-3 h-8 w-28 rounded-full bg-muted blur-2xl" />
                      <span className="absolute left-4 top-6 size-2 rounded-full border border-border" />
                      <span className="absolute right-5 top-12 size-1.5 rounded-full border border-border" />
                      <span className="absolute left-8 bottom-8 size-3 text-border">+</span>
                      <span className="absolute right-8 bottom-10 size-3 text-border">+</span>
                      <Ghost className="relative size-24 text-muted-foreground/35" strokeWidth={1.5} />
                    </div>
                    <div className="space-y-1">
                      <p className="text-lg font-semibold tracking-tight">No bookings for this view</p>
                      <p className="text-sm text-muted-foreground">
                        Try another date or adjust the current product filter.
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <div>
                  {groupedBookings.map((group) => (
                    <div key={group.slotKey} className="border-t pb-4 first:border-t-0 last:pb-0">
                      <header className="sticky top-0 z-20 grid grid-cols-[1fr_auto] items-center gap-2 bg-card/95 px-3 py-2.5 backdrop-blur">
                        <p className="text-2xl font-semibold tracking-tight">{group.slotLabel}</p>
                        <p className="text-2xl font-semibold tracking-tight">
                          {group.checkedPax} <span className="text-muted-foreground">of {group.totalPax}</span>
                        </p>
                      </header>

                      <div data-booking-group className="mt-2">
                        {group.rows.map((booking) => {
                        const customer = booking.customer_id ? customerById.get(booking.customer_id) : undefined;
                        const customerName = customer
                          ? `${customer.first_name} ${customer.last_name}`.trim()
                          : "Unknown customer";
                        const product = productById.get(booking.product_id);
                        const productLabel = product?.product_name || product?.short_name || "Unknown product";
                        const rowColor = toSoftRowColor(product?.color);
                        const isCheckedUpdating = updatingCheckedIds.includes(booking.id);
                        const isPeekUpdating = updatingPeekIds.includes(booking.id);

                        return (
                          <article
                            id={`booking-${booking.id}`}
                            key={booking.id}
                            style={rowColor ? { backgroundColor: rowColor } : undefined}
                            className={cn(
                              "scroll-mt-28 grid items-center gap-2 px-3 py-3 text-sm transition-all first:rounded-t-2xl last:rounded-b-2xl",
                              rowColor ? "hover:brightness-[0.985]" : "",
                              highlightedBookingId === booking.id
                                ? "relative z-10 ring-2 ring-indigo-400 ring-offset-2 ring-offset-background shadow-lg"
                                : "",
                              "grid-cols-[3.25rem_minmax(12rem,1.35fr)_minmax(9rem,.82fr)_minmax(8rem,.88fr)_3rem_2rem_minmax(11rem,1.25fr)_auto]",
                            )}
                          >
                            <div className="flex w-fit items-center gap-1 justify-self-start">
                              <span className="shrink-0 text-xs font-medium text-muted-foreground">
                                ID
                              </span>
                              {!privacyMode ? (
                                <button
                                  type="button"
                                  onClick={() => void handleCopyField(
                                    `${booking.id}:reference`,
                                    booking.booking_reference,
                                    "Unable to copy booking ID.",
                                  )}
                                  className="relative inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                                >
                                  <span className="sr-only">Copy booking ID</span>
                                  {copiedFieldKey === `${booking.id}:reference` ? (
                                    <>
                                      <Check className="size-3.5 animate-in zoom-in-75 text-emerald-600" />
                                      <div className="pointer-events-none absolute bottom-full left-1/2 z-30 -translate-x-1/2 pb-3">
                                        <span className="relative block rounded-2xl bg-foreground px-3 py-1.5 text-[10px] font-semibold text-background shadow-2xl animate-in fade-in zoom-in-95 duration-200">
                                          Copied
                                          <span
                                            aria-hidden="true"
                                            className="absolute left-1/2 top-full size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-foreground"
                                          />
                                        </span>
                                      </div>
                                    </>
                                  ) : (
                                    <Copy className="size-3.5" />
                                  )}
                                </button>
                              ) : null}
                            </div>

                            <HoverTooltip label={customerName}>
                              <p className="truncate font-semibold">{customerName}</p>
                            </HoverTooltip>
                            <div className="flex min-w-0 w-full items-center justify-between gap-2">
                              <HoverTooltip label={customer?.phone ?? ""} className="flex-1">
                                <p className="truncate text-muted-foreground">{customer?.phone ?? ""}</p>
                              </HoverTooltip>
                              {customer?.phone ? (
                                <button
                                  type="button"
                                  onClick={() => void handleCopyField(
                                    `${booking.id}:phone`,
                                    customer.phone,
                                    "Unable to copy phone number.",
                                  )}
                                  className="relative inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                                >
                                  <span className="sr-only">Copy phone number</span>
                                  {copiedFieldKey === `${booking.id}:phone` ? (
                                    <>
                                      <Check className="size-3.5 animate-in zoom-in-75 text-emerald-600" />
                                      <div className="pointer-events-none absolute bottom-full left-1/2 z-30 -translate-x-1/2 pb-3">
                                        <span className="relative block rounded-2xl bg-foreground px-3 py-1.5 text-[10px] font-semibold text-background shadow-2xl animate-in fade-in zoom-in-95 duration-200">
                                          Copied
                                          <span
                                            aria-hidden="true"
                                            className="absolute left-1/2 top-full size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-foreground"
                                          />
                                        </span>
                                      </div>
                                    </>
                                  ) : (
                                    <Copy className="size-3.5" />
                                  )}
                                </button>
                              ) : null}
                            </div>
                            <HoverTooltip label={privacyMode ? "" : booking.supplier}>
                              <p className="truncate text-muted-foreground">
                                {privacyMode ? "" : booking.supplier}
                              </p>
                            </HoverTooltip>
                            <div className="flex items-center gap-2 text-base font-semibold">
                              <span>{booking.adult > 0 ? booking.adult : booking.paxs}</span>
                              {booking.child > 0 ? <span className="text-sky-500">{booking.child}</span> : null}
                              {booking.infant > 0 ? (
                                <span className="text-violet-400">/{booking.infant}</span>
                              ) : null}
                            </div>

                            <div className="flex justify-center">
                              <input
                                type="checkbox"
                                checked={booking.checked}
                                onChange={() => handleToggleChecked(booking.id, booking.checked)}
                                disabled={isCheckedUpdating}
                                aria-label="Toggle checked status"
                                className="size-4 accent-fuchsia-600 disabled:cursor-not-allowed"
                              />
                            </div>

                            <HoverTooltip label={productLabel}>
                              <p className="truncate text-muted-foreground">{productLabel}</p>
                            </HoverTooltip>

                            <div className="grid grid-cols-[2rem_2rem_2rem_auto] items-center justify-end gap-2">
                              {booking.note.trim() ? (
                                <div
                                  ref={openNoteBookingId === booking.id ? openNoteContainerRef : null}
                                  className="relative"
                                >
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      const trigger =
                                        event.currentTarget instanceof HTMLElement
                                          ? event.currentTarget
                                          : null;
                                      closePhotoGallery();
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
                                    className={cn(
                                      rowActionButtonClass,
                                      openNoteBookingId === booking.id ? "border-indigo-200 bg-indigo-50" : "",
                                    )}
                                  >
                                    <span className="sr-only">Show booking note</span>
                                    <StickyNote className="size-4" />
                                  </button>
                                  {openNoteBookingId === booking.id &&
                                  openNoteLayout &&
                                  typeof document !== "undefined"
                                    ? createPortal(
                                        <div
                                          ref={openNotePanelRef}
                                          className={cn(
                                            "fixed z-[90]",
                                            openNoteLayout.placement === "top" ? "-translate-y-full" : "",
                                          )}
                                          style={{
                                            left: openNoteLayout.left,
                                            top: openNoteLayout.top,
                                            width: openNoteLayout.width,
                                          }}
                                        >
                                          <div className="relative rounded-2xl bg-foreground px-4 py-3 text-left text-sm leading-snug text-background shadow-2xl animate-in fade-in zoom-in-95 duration-200">
                                            <span
                                              aria-hidden="true"
                                              className={cn(
                                                "absolute size-3 rotate-45 bg-foreground",
                                                openNoteLayout.placement === "top"
                                                  ? "top-full -translate-y-1/2"
                                                  : "bottom-full translate-y-1/2",
                                              )}
                                              style={{ left: openNoteLayout.arrowLeft }}
                                            />
                                            <div className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words">
                                              {booking.note.trim()}
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
                              {booking.photo_urls.length > 0 ? (
                                <button
                                  type="button"
                                  onClick={() => openPhotoGallery(booking)}
                                  className={rowActionButtonClass}
                                >
                                  <span className="sr-only">Show booking photos</span>
                                  <ImageIcon className="size-4" />
                                </button>
                              ) : null}
                              {booking.photo_urls.length === 0 ? (
                                <span className="size-8" aria-hidden="true" />
                              ) : null}
                              <button
                                type="button"
                                onClick={() => openEditBooking(booking)}
                                className={rowActionButtonClass}
                              >
                                <span className="sr-only">Edit booking</span>
                                <PencilLine className="size-4" />
                              </button>
                              {!privacyMode ? (
                                <button
                                  type="button"
                                  onClick={() => handleTogglePeek(booking.id, booking.peek)}
                                  disabled={isPeekUpdating}
                                  className={cn(
                                    "inline-flex size-14 shrink-0 items-center justify-center rounded-lg border text-center text-sm font-semibold leading-[1.05] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60",
                                    booking.peek
                                      ? "border-yellow-200 bg-yellow-200 text-yellow-950 shadow-sm"
                                      : "border-muted bg-background text-foreground hover:bg-muted",
                                  )}
                                >
                                  <span className="sr-only">
                                    {booking.peek ? "Remove from Peek" : "Add to Peek"}
                                  </span>
                                  <span className="whitespace-pre-line">
                                    {isPeekUpdating ? "saving..." : booking.peek ? "added\nto\nPeek" : "add\nto\nPeek"}
                                  </span>
                                </button>
                              ) : null}
                            </div>
                          </article>
                        );
                      })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      </section>

      {isProductFilterOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4 py-6 animate-in fade-in duration-200"
          role="presentation"
          onMouseDown={() => setIsProductFilterOpen(false)}
        >
          <div
            aria-labelledby="product-filter-title"
            aria-modal="true"
            className="flex max-h-[88vh] w-full max-w-[28rem] flex-col overflow-hidden rounded-xl border bg-card shadow-2xl animate-in fade-in zoom-in-95 slide-in-from-bottom-4 duration-300"
            role="dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="border-b px-5 py-4 text-center">
              <h2 id="product-filter-title" className="text-lg font-semibold tracking-tight">
                Filter by Product
              </h2>
            </div>

            <div className="grid gap-1.5 overflow-y-auto px-5 py-4">
              <button
                type="button"
                onClick={() => setDraftSelectedProductIds([])}
                aria-pressed={draftSelectedProductIds.length === 0}
                className={cn(
                  "flex min-h-12 w-full items-center justify-between gap-3 rounded-lg border px-3 text-left text-sm font-medium transition-colors",
                  draftSelectedProductIds.length === 0
                    ? "border-indigo-200 bg-indigo-50 text-indigo-600"
                    : "border-transparent text-foreground hover:bg-muted",
                )}
              >
                <span>All Products</span>
                {draftSelectedProductIds.length === 0 ? <Check className="size-5 shrink-0" /> : null}
              </button>

              {products.map((product) => {
                const isSelected = draftSelectedProductIds.includes(product.id);
                const productLabel = product.product_name || product.short_name || "Unnamed product";

                return (
                  <button
                    key={product.id}
                    type="button"
                    onClick={() => toggleDraftProduct(product.id)}
                    aria-pressed={isSelected}
                    className={cn(
                      "flex min-h-12 w-full items-center justify-between gap-3 rounded-lg border px-3 text-left text-sm font-medium transition-colors",
                      isSelected
                        ? "border-indigo-200 bg-indigo-50 text-indigo-600"
                        : "border-transparent text-foreground hover:bg-muted",
                    )}
                  >
                    <span className="min-w-0 truncate">{productLabel}</span>
                    {isSelected ? <Check className="size-5 shrink-0" /> : null}
                  </button>
                );
              })}
            </div>

            <div className="border-t bg-muted/40 px-5 py-4">
              <Button
                type="button"
                onClick={applyProductFilter}
                className="h-10 w-full"
              >
                Done
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {editForm ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4 py-6 animate-in fade-in duration-200"
          role="presentation"
          onMouseDown={closeEditBooking}
        >
          <form
            aria-labelledby="booking-edit-title"
            aria-modal="true"
            className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border bg-card shadow-2xl animate-in fade-in zoom-in-95 slide-in-from-bottom-4 duration-300"
            role="dialog"
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={handleSaveBookingEdit}
          >
            <div className="flex items-center justify-between border-b px-5 py-3">
              <h2 id="booking-edit-title" className="text-lg font-semibold tracking-tight">
                Edit booking
              </h2>
              <button
                type="button"
                onClick={closeEditBooking}
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
                        value={editForm.adult}
                        onChange={(event) => updateEditForm("adult", event.target.value)}
                        className="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-center text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50"
                      />
                    </label>
                    <label className="grid w-16 gap-1 text-sm font-medium">
                      Child
                      <input
                        type="number"
                        min="0"
                        value={editForm.child}
                        onChange={(event) => updateEditForm("child", event.target.value)}
                        className="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-center text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50"
                      />
                    </label>
                    <label className="grid w-16 gap-1 text-sm font-medium">
                      Infant
                      <input
                        type="number"
                        min="0"
                        value={editForm.infant}
                        onChange={(event) => updateEditForm("infant", event.target.value)}
                        className="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-center text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50"
                      />
                    </label>
                  </div>

                  <label className={cn(editFieldClass, "max-w-xs")}>
                    Supplier
                    <input
                      value={editForm.supplier}
                      onChange={(event) => updateEditForm("supplier", event.target.value)}
                      className={editInputClass}
                    />
                  </label>

                  <label className={cn(editFieldClass, "max-w-xs")}>
                    Booking reference
                    <input
                      required
                      value={editForm.bookingReference}
                      onChange={(event) => updateEditForm("bookingReference", event.target.value)}
                      className={editInputClass}
                    />
                  </label>

                  <label className={cn(editFieldClass, "max-w-xs")}>
                    Product
                    <select
                      required
                      value={editForm.productId}
                      onChange={(event) => updateEditForm("productId", event.target.value)}
                      className={editInputClass}
                    >
                      {products.map((product) => (
                        <option key={product.id} value={product.id}>
                          {product.product_name || product.short_name || "Unnamed product"}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="grid max-w-xs gap-2.5 sm:grid-cols-[minmax(0,1fr)_8.5rem]">
                    <label className={editFieldClass}>
                      Date
                      <input
                        required
                        type="date"
                        value={editForm.date}
                        onChange={(event) => updateEditForm("date", event.target.value)}
                        className={editInputClass}
                      />
                    </label>
                    <label className={editFieldClass}>
                      Time
                      <input
                        required
                        type="time"
                        value={editForm.time}
                        onChange={(event) => updateEditForm("time", event.target.value)}
                        className={editInputClass}
                      />
                    </label>
                  </div>

                  <label className={cn(editFieldClass, "max-w-xs")}>
                    Status
                    <select
                      required
                      value={editForm.status}
                      onChange={(event) => updateEditForm("status", event.target.value)}
                      className={editInputClass}
                    >
                      {statusOptions.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className={cn(editFieldClass, "max-w-sm")}>
                    Note
                    <textarea
                      value={editForm.note}
                      onChange={(event) => updateEditForm("note", event.target.value)}
                      className={editTextareaClass}
                    />
                  </label>
                </div>
              </section>

              <section className="min-w-0">
                <h3 className="mb-3 text-base font-semibold">Customer information</h3>
                <fieldset className="grid gap-2.5">
                  <div className="grid max-w-sm gap-2.5 sm:grid-cols-2">
                    <label className={cn(editFieldClass, "min-w-0")}>
                      First name
                      <input
                        value={editForm.firstName}
                        onChange={(event) => updateEditForm("firstName", event.target.value)}
                        className={editInputClass}
                      />
                    </label>
                    <label className={cn(editFieldClass, "min-w-0")}>
                      Last name
                      <input
                        value={editForm.lastName}
                        onChange={(event) => updateEditForm("lastName", event.target.value)}
                        className={editInputClass}
                      />
                    </label>
                  </div>

                  <label className={cn(editFieldClass, "max-w-sm")}>
                    Phone
                    <input
                      value={editForm.phone}
                      onChange={(event) => updateEditForm("phone", event.target.value)}
                      className={editInputClass}
                    />
                  </label>

                  <label className={cn(editFieldClass, "max-w-sm")}>
                    Email
                    <input
                      type="email"
                      value={editForm.email}
                      onChange={(event) => updateEditForm("email", event.target.value)}
                      className={editInputClass}
                    />
                  </label>
                </fieldset>
              </section>
            </div>

            {editError ? (
              <p className="mx-5 mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {editError}
              </p>
            ) : null}

            <div className="flex items-center justify-between gap-3 border-t bg-muted/40 px-5 py-4">
              <Button
                type="button"
                variant="destructive"
                onClick={handleDeleteBooking}
                disabled={isEditSaving || isEditDeleting}
              >
                {isEditDeleting ? "Deleting..." : "Delete"}
              </Button>
              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={closeEditBooking}
                  disabled={isEditSaving || isEditDeleting}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isEditSaving || isEditDeleting || !isEditDirty}>
                  {isEditSaving ? "Saving..." : "Save"}
                </Button>
              </div>
            </div>
          </form>
        </div>
      ) : null}

      {openPhotoBooking ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4 py-6 animate-in fade-in duration-200"
          role="presentation"
          onMouseDown={closePhotoGallery}
        >
          <div
            aria-labelledby="booking-photo-title"
            aria-modal="true"
            className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border bg-card shadow-2xl animate-in fade-in zoom-in-95 slide-in-from-bottom-4 duration-300"
            role="dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b px-5 py-4">
              <div>
                <h2 id="booking-photo-title" className="text-lg font-semibold tracking-tight">
                  Booking photos
                </h2>
                <p className="text-sm text-muted-foreground">
                  {openPhotoBooking.photo_urls.length} photo{openPhotoBooking.photo_urls.length === 1 ? "" : "s"}
                </p>
              </div>
              <button
                type="button"
                onClick={closePhotoGallery}
                aria-label="Close booking photos"
                className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="grid gap-4 overflow-y-auto px-5 py-5">
              {activePhotoUrl ? (
                <div className="overflow-hidden rounded-lg border bg-muted/20">
                  <div className="flex items-center justify-between gap-3 border-b bg-muted/40 px-4 py-3">
                    <p className="text-sm text-muted-foreground">
                      Photo {Math.min(activePhotoIndex + 1, openPhotoBooking.photo_urls.length)} of{" "}
                      {openPhotoBooking.photo_urls.length}
                    </p>
                    <a
                      href={activePhotoUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                    >
                      Open original
                    </a>
                  </div>
                  <div className="flex h-[min(68vh,42rem)] items-center justify-center p-4 sm:p-6">
                    <NextImage
                      src={activePhotoUrl}
                      alt={`Booking photo ${activePhotoIndex + 1}`}
                      width={1600}
                      height={1200}
                      unoptimized
                      sizes="100vw"
                      className="h-auto max-h-full w-auto max-w-full object-contain"
                    />
                  </div>
                </div>
              ) : null}

              <div
                className={cn(
                  "grid gap-4",
                  openPhotoBooking.photo_urls.length === 1
                    ? "grid-cols-1 max-w-[14rem]"
                    : "sm:grid-cols-2 lg:grid-cols-3",
                )}
              >
                {openPhotoBooking.photo_urls.map((photoUrl, index) => (
                  <button
                    key={`${openPhotoBooking.id}:${index}`}
                    type="button"
                    onClick={() => setActivePhotoIndex(index)}
                    className={cn(
                      "group overflow-hidden rounded-lg border bg-muted/30 text-left transition",
                      index === activePhotoIndex
                        ? "border-indigo-300 ring-2 ring-indigo-200"
                        : "hover:border-muted-foreground/20",
                    )}
                  >
                    <div className="flex h-36 items-center justify-center p-3">
                      <NextImage
                        src={photoUrl}
                        alt={`Booking photo thumbnail ${index + 1}`}
                        width={600}
                        height={450}
                        unoptimized
                        sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                        className="h-full w-full object-contain transition group-hover:scale-[1.01]"
                      />
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

export default function OrdersPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-gradient-to-b from-background via-background to-muted/40">
          <section className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-6">
            <p className="text-sm text-muted-foreground">Loading bookings...</p>
          </section>
        </main>
      }
    >
      <OrdersContent />
    </Suspense>
  );
}
