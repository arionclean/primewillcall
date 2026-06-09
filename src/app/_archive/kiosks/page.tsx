"use client";

import { FormEvent, Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CalendarPlus,
  Check,
  ChevronLeft,
  ChevronRight,
  DollarSign,
  LayoutDashboard,
  Link as LinkIcon,
  Monitor,
  Package,
  Plus,
  QrCode,
  Receipt,
  Settings,
  Smartphone,
  Ticket,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import GlobalSearchBar from "@/components/global-search-bar";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

type PaymentType = "cash" | "card_link" | "qr" | "tap";
type KioskTab = "willcall" | "add";

type Company = {
  id: string;
  user_id: string | null;
  name: string | null;
  email: string | null;
  stripe_account_id: string | null;
  charges_enabled: boolean | null;
};

type TeamMember = {
  id: string;
  company_id: string;
  role: "admin" | "kiosk";
  is_active: boolean;
  can_create_booking: boolean;
};

type Product = {
  id: string;
  company_id: string;
  product_name: string;
  short_name: string;
  color: string | null;
  price: unknown;
  timeslots: unknown;
};

type BookingRow = {
  id: string;
  booking_reference: string;
  adult: number;
  child: number;
  infant: number;
  paxs: number;
  checked: boolean;
  date_timestamp: string;
  status: string;
  customer_id: string | null;
  product_id: string;
  price: number;
};

type Customer = {
  id: string;
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
};

type KioskSale = {
  id: string;
  booking_id: string;
  product_id: string;
  amount_cents: number;
  payment_type: PaymentType;
  status: string;
  created_at: string;
};

const sidebarItems = [
  { label: "Overview", icon: LayoutDashboard, href: "/dashboard" },
  { label: "Orders", icon: Receipt, href: "/orders" },
  { label: "Schedule", icon: CalendarPlus, href: "/schedule" },
  { label: "Products", icon: Package, href: "/products" },
  { label: "Kiosks", icon: Monitor, href: "/kiosks", active: true },
  { label: "Team", icon: Users, href: "/team" },
  { label: "Settings", icon: Settings, href: "#" },
];

const paymentOptions: Array<{ value: PaymentType; label: string; icon: typeof DollarSign }> = [
  { value: "cash", label: "Cash", icon: DollarSign },
  { value: "card_link", label: "Card link", icon: LinkIcon },
  { value: "qr", label: "QR", icon: QrCode },
  { value: "tap", label: "Tap", icon: Smartphone },
];

const moneyFormatter = new Intl.NumberFormat("en-US", {
  currency: "USD",
  style: "currency",
});

const dateLabelFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const timeLabelFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
});

function todayLocalIsoDate() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function formatCents(cents: number) {
  return moneyFormatter.format(cents / 100);
}

function parseNonNegativeInteger(value: string) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseDecimalToCents(value: unknown) {
  const parsed = Number.parseFloat(String(value ?? 0));
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) : 0;
}

function getProductPriceCents(product: Product | null, key: "adult" | "child" | "infant") {
  if (!product || typeof product.price !== "object" || product.price === null) {
    return 0;
  }

  const price = product.price as Record<string, unknown>;
  return parseDecimalToCents(price[key]);
}

function normalizeTimeslots(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((slot) => String(slot).trim())
    .filter(Boolean)
    .map((slot) => {
      if (/^\d{2}:\d{2}$/.test(slot)) {
        return slot;
      }

      const parsed = new Date(`1970-01-01T${slot}`);
      return Number.isNaN(parsed.getTime()) ? slot : parsed.toISOString().slice(11, 16);
    });
}

function generateReference(prefix: string) {
  const stamp = Date.now().toString(36).toUpperCase().slice(-6);
  const random = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}-${stamp}${random}`;
}

function dateRangeForIsoDate(date: string) {
  const start = new Date(`${date}T00:00:00Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  return { end: end.toISOString(), start: start.toISOString() };
}

function fullCustomerName(customer: Customer | undefined) {
  if (!customer) {
    return "Unknown customer";
  }

  return `${customer.first_name} ${customer.last_name}`.trim() || "Unknown customer";
}

function paymentLabel(type: PaymentType) {
  switch (type) {
    case "card_link":
      return "card link";
    case "qr":
      return "QR";
    case "tap":
      return "tap";
    default:
      return "cash";
  }
}

function KiosksContent() {
  const router = useRouter();

  const [isLoading, setIsLoading] = useState(true);
  const [isDataLoading, setIsDataLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [selectedDate, setSelectedDate] = useState(todayLocalIsoDate);
  const [products, setProducts] = useState<Product[]>([]);
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [sales, setSales] = useState<KioskSale[]>([]);
  const [saleBookings, setSaleBookings] = useState<BookingRow[]>([]);
  const [activeTab, setActiveTab] = useState<KioskTab>("willcall");
  const [reloadKey, setReloadKey] = useState(0);

  const [productId, setProductId] = useState("");
  const [saleKind, setSaleKind] = useState<"ticket" | "product">("ticket");
  const [adult, setAdult] = useState("0");
  const [child, setChild] = useState("0");
  const [infant, setInfant] = useState("0");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [bookingDate, setBookingDate] = useState(todayLocalIsoDate);
  const [bookingTime, setBookingTime] = useState("");
  const [paymentType, setPaymentType] = useState<PaymentType>("cash");

  const selectedCompany = useMemo(
    () => companies.find((company) => company.id === selectedCompanyId) ?? null,
    [companies, selectedCompanyId],
  );

  const selectedProduct = useMemo(
    () => products.find((product) => product.id === productId) ?? null,
    [productId, products],
  );

  const productById = useMemo(() => {
    const map = new Map<string, Product>();

    for (const product of products) {
      map.set(product.id, product);
    }

    return map;
  }, [products]);

  const customerById = useMemo(() => {
    const map = new Map<string, Customer>();

    for (const customer of customers) {
      map.set(customer.id, customer);
    }

    return map;
  }, [customers]);

  const bookingById = useMemo(() => {
    const map = new Map<string, BookingRow>();

    for (const booking of [...bookings, ...saleBookings]) {
      map.set(booking.id, booking);
    }

    return map;
  }, [bookings, saleBookings]);

  const activeTeamMember = useMemo(
    () =>
      teamMembers.find((member) => member.company_id === selectedCompanyId && member.is_active) ??
      null,
    [selectedCompanyId, teamMembers],
  );

  const isOwnerCompany = selectedCompany?.user_id ? !activeTeamMember : companies.length > 0 && !activeTeamMember;
  const canCreateBooking = Boolean(
    selectedCompanyId && (isOwnerCompany || activeTeamMember?.role === "admin" || activeTeamMember?.can_create_booking),
  );
  const selectedTimeslots = normalizeTimeslots(selectedProduct?.timeslots);
  const adultCount = parseNonNegativeInteger(adult);
  const childCount = parseNonNegativeInteger(child);
  const infantCount = parseNonNegativeInteger(infant);
  const totalPaxs = adultCount + childCount + infantCount;
  const totalCents =
    adultCount * getProductPriceCents(selectedProduct, "adult") +
    childCount * getProductPriceCents(selectedProduct, "child") +
    infantCount * getProductPriceCents(selectedProduct, "infant");
  const cardPaymentsAvailable = Boolean(selectedCompany?.stripe_account_id && selectedCompany?.charges_enabled);
  const selectedCardMethod = paymentType !== "cash";
  const formCanSubmit =
    canCreateBooking &&
    Boolean(productId) &&
    firstName.trim().length > 0 &&
    bookingDate.length > 0 &&
    totalPaxs > 0 &&
    !selectedCardMethod;

  const cashTotal = sales
    .filter((sale) => sale.payment_type === "cash" && sale.status !== "failed")
    .reduce((total, sale) => total + sale.amount_cents, 0);
  const cardTotal = sales
    .filter((sale) => sale.payment_type !== "cash" && sale.status !== "failed")
    .reduce((total, sale) => total + sale.amount_cents, 0);

  useEffect(() => {
    const loadContext = async () => {
      try {
        const supabase = getSupabaseBrowserClient();
        const { data: sessionData } = await supabase.auth.getSession();
        const userId = sessionData.session?.user.id;

        if (!userId) {
          router.replace("/login");
          return;
        }

        const [{ data: ownerCompanies, error: ownerError }, { data: memberRows, error: memberError }] =
          await Promise.all([
            supabase
              .from("companies")
              .select("id, user_id, name, email, stripe_account_id, charges_enabled")
              .eq("user_id", userId)
              .order("created_at", { ascending: true }),
            supabase
              .from("team_members")
              .select("id, company_id, role, is_active, can_create_booking")
              .eq("auth_user_id", userId)
              .eq("is_active", true),
          ]);

        if (ownerError) {
          throw new Error(ownerError.message);
        }
        if (memberError) {
          throw new Error(memberError.message);
        }

        const safeTeamMembers = (memberRows ?? []) as TeamMember[];
        const teamCompanyIds = [...new Set(safeTeamMembers.map((member) => member.company_id))];
        let teamCompanies: Company[] = [];

        if (teamCompanyIds.length > 0) {
          const { data: teamCompanyRows, error: teamCompanyError } = await supabase
            .from("companies")
            .select("id, user_id, name, email, stripe_account_id, charges_enabled")
            .in("id", teamCompanyIds)
            .order("created_at", { ascending: true });

          if (teamCompanyError) {
            throw new Error(teamCompanyError.message);
          }

          teamCompanies = (teamCompanyRows ?? []) as Company[];
        }

        const companyMap = new Map<string, Company>();

        for (const company of [...((ownerCompanies ?? []) as Company[]), ...teamCompanies]) {
          companyMap.set(company.id, company);
        }

        const safeCompanies = [...companyMap.values()];
        setCompanies(safeCompanies);
        setTeamMembers(safeTeamMembers);
        setSelectedCompanyId(safeCompanies[0]?.id ?? "");
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : "Unable to load kiosk.");
      } finally {
        setIsLoading(false);
      }
    };

    void loadContext();
  }, [router]);

  useEffect(() => {
    setBookingDate(selectedDate);
  }, [selectedDate]);

  useEffect(() => {
    if (!selectedCompanyId) {
      setProducts([]);
      setBookings([]);
      setCustomers([]);
      setSales([]);
      setSaleBookings([]);
      return;
    }

    let cancelled = false;

    const loadData = async () => {
      setIsDataLoading(true);
      setLoadError(null);

      try {
        const supabase = getSupabaseBrowserClient();
        const range = dateRangeForIsoDate(selectedDate);
        const [{ data: productRows, error: productError }, { data: bookingRows, error: bookingError }] =
          await Promise.all([
            supabase
              .from("products")
              .select("id, company_id, product_name, short_name, color, price, timeslots")
              .eq("company_id", selectedCompanyId)
              .order("created_at", { ascending: true }),
            supabase
              .from("bookings")
              .select(
                "id, booking_reference, adult, child, infant, paxs, checked, date_timestamp, status, customer_id, product_id, price",
              )
              .eq("company_id", selectedCompanyId)
              .gte("date_timestamp", range.start)
              .lt("date_timestamp", range.end)
              .order("date_timestamp", { ascending: true }),
          ]);

        if (productError) {
          throw new Error(productError.message);
        }
        if (bookingError) {
          throw new Error(bookingError.message);
        }

        const safeProducts = (productRows ?? []) as Product[];
        const safeBookings = (bookingRows ?? []) as BookingRow[];
        const customerIds = [
          ...new Set(
            safeBookings
              .map((booking) => booking.customer_id)
              .filter((customerId): customerId is string => Boolean(customerId)),
          ),
        ];
        let customerRows: Customer[] = [];

        if (customerIds.length > 0) {
          const { data, error } = await supabase
            .from("customers")
            .select("id, first_name, last_name, phone, email")
            .in("id", customerIds);

          if (error) {
            throw new Error(error.message);
          }

          customerRows = (data ?? []) as Customer[];
        }

        const { data: saleRows, error: salesError } = await supabase
          .from("kiosk_sales")
          .select("id, booking_id, product_id, amount_cents, payment_type, status, created_at")
          .eq("company_id", selectedCompanyId)
          .gte("created_at", range.start)
          .lt("created_at", range.end)
          .order("created_at", { ascending: false });

        if (salesError && salesError.code !== "42P01") {
          throw new Error(salesError.message);
        }

        const safeSales = (saleRows ?? []) as KioskSale[];
        const missingSaleBookingIds = [
          ...new Set(
            safeSales
              .map((sale) => sale.booking_id)
              .filter((bookingId) => !safeBookings.some((booking) => booking.id === bookingId)),
          ),
        ];
        let extraBookings: BookingRow[] = [];

        if (missingSaleBookingIds.length > 0) {
          const { data, error } = await supabase
            .from("bookings")
            .select(
              "id, booking_reference, adult, child, infant, paxs, checked, date_timestamp, status, customer_id, product_id, price",
            )
            .in("id", missingSaleBookingIds);

          if (error) {
            throw new Error(error.message);
          }

          extraBookings = (data ?? []) as BookingRow[];
        }

        if (!cancelled) {
          setProducts(safeProducts);
          setBookings(safeBookings);
          setCustomers(customerRows);
          setSales(safeSales);
          setSaleBookings(extraBookings);
          setProductId((current) => {
            if (current && safeProducts.some((product) => product.id === current)) {
              return current;
            }

            return safeProducts[0]?.id ?? "";
          });
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "Unable to load kiosk data.");
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
  }, [reloadKey, selectedCompanyId, selectedDate]);

  useEffect(() => {
    if (!selectedProduct) {
      setBookingTime("");
      return;
    }

    const timeslots = normalizeTimeslots(selectedProduct.timeslots);
    setBookingTime((current) => (current && timeslots.includes(current) ? current : timeslots[0] ?? ""));
  }, [selectedProduct]);

  const handleSignOut = async () => {
    const supabase = getSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  };

  const adjustCount = (kind: "adult" | "child" | "infant", delta: number) => {
    const setter = kind === "adult" ? setAdult : kind === "child" ? setChild : setInfant;
    const current = kind === "adult" ? adult : kind === "child" ? child : infant;
    setter(String(Math.max(0, parseNonNegativeInteger(current) + delta)));
  };

  const resetBookingForm = () => {
    setAdult("0");
    setChild("0");
    setInfant("0");
    setFirstName("");
    setLastName("");
    setPhone("");
    setEmail("");
    setBookingDate(selectedDate);
    setPaymentType("cash");
  };

  const handleCreateBooking = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    setSuccessMessage(null);

    if (!selectedCompanyId || !selectedCompany || !selectedProduct) {
      setFormError("Pick a company and product before adding a booking.");
      return;
    }
    if (!canCreateBooking) {
      setFormError("This account does not have permission to create kiosk bookings.");
      return;
    }
    if (totalPaxs <= 0) {
      setFormError("Add at least one ticket before creating the booking.");
      return;
    }
    if (!firstName.trim()) {
      setFormError("First name is required.");
      return;
    }
    if (selectedCardMethod) {
      setFormError("Card charging needs the Stripe Connect payment endpoint before this can run live.");
      return;
    }

    setIsSubmitting(true);

    try {
      const supabase = getSupabaseBrowserClient();
      const reference = generateReference("KIOSK");
      const customerEmail = email.trim() || `kiosk-${reference.toLowerCase()}@legacy.local`;
      const dateTimestamp = new Date(`${bookingDate}T${bookingTime || "00:00"}:00Z`).toISOString();

      const { data: customerRow, error: customerError } = await supabase
        .from("customers")
        .insert({
          company_id: selectedCompanyId,
          first_name: firstName.trim(),
          last_name: lastName.trim() || "Customer",
          email: customerEmail,
          phone: phone.trim(),
          country: "",
        })
        .select("id")
        .single();

      if (customerError) {
        throw new Error(customerError.message);
      }

      const { data: bookingRow, error: bookingError } = await supabase
        .from("bookings")
        .insert({
          adult: adultCount,
          booking_channel: "kiosk",
          booking_reference: reference,
          checked: false,
          child: childCount,
          company_id: selectedCompanyId,
          paxs: totalPaxs,
          date_timestamp: dateTimestamp,
          product_id: selectedProduct.id,
          infant: infantCount,
          internal_id: reference,
          status: "confirmed",
          supplier: activeTeamMember ? "kiosk" : "manual kiosk",
          note: "",
          check_in_time: null,
          customer_id: customerRow?.id ?? null,
          product_var: saleKind,
          peek: false,
          price: totalCents,
        })
        .select("id")
        .single();

      if (bookingError) {
        throw new Error(bookingError.message);
      }

      const { error: saleError } = await supabase.from("kiosk_sales").insert({
        company_id: selectedCompanyId,
        product_id: selectedProduct.id,
        booking_id: bookingRow.id,
        team_member_id: activeTeamMember?.id ?? null,
        amount_cents: totalCents,
        payment_type: paymentType,
        status: paymentType === "cash" ? "paid" : "pending",
        connected_account_id: selectedCompany.stripe_account_id,
      });

      if (saleError) {
        throw new Error(saleError.message);
      }

      setSuccessMessage(`Booking ${reference} created for ${formatCents(totalCents)}.`);
      resetBookingForm();
      setActiveTab("willcall");
      setReloadKey((current) => current + 1);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Unable to create kiosk booking.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <main className="min-h-screen bg-gradient-to-b from-background via-background to-muted/40">
        <section className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-6">
          <p className="text-sm text-muted-foreground">Loading kiosk...</p>
        </section>
      </main>
    );
  }

  const inputClass =
    "h-10 w-full rounded-md border bg-background px-3 text-sm outline-none transition placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50";
  const labelClass = "grid gap-1.5 text-sm font-medium";

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

            <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Kiosks</p>
                <h1 className="text-3xl font-semibold tracking-tight">Kiosk will call</h1>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(event) => setSelectedDate(event.target.value)}
                  className="h-10 rounded-md border bg-background px-3 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50"
                />
                <div className="inline-flex rounded-md border bg-card p-1">
                  <button
                    type="button"
                    onClick={() => setActiveTab("willcall")}
                    className={cn(
                      "inline-flex h-8 items-center gap-2 rounded px-3 text-sm font-medium transition",
                      activeTab === "willcall" ? "bg-primary text-primary-foreground" : "text-muted-foreground",
                    )}
                  >
                    <Ticket className="size-4" />
                    Will call
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab("add")}
                    className={cn(
                      "inline-flex h-8 items-center gap-2 rounded px-3 text-sm font-medium transition",
                      activeTab === "add" ? "bg-primary text-primary-foreground" : "text-muted-foreground",
                    )}
                  >
                    <Plus className="size-4" />
                    Add booking
                  </button>
                </div>
              </div>
            </div>

            {loadError ? (
              <p className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {loadError}
              </p>
            ) : null}
            {successMessage ? (
              <p className="mb-4 flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                <Check className="size-4" />
                {successMessage}
              </p>
            ) : null}

            {activeTab === "willcall" ? (
              <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
                <section className="rounded-xl border bg-card">
                  <div className="flex items-center justify-between border-b px-4 py-3">
                    <div>
                      <h2 className="font-semibold tracking-tight">Allowed bookings</h2>
                      <p className="text-sm text-muted-foreground">
                        {dateLabelFormatter.format(new Date(`${selectedDate}T00:00:00Z`))}
                      </p>
                    </div>
                    <span className="text-sm text-muted-foreground">{bookings.length} bookings</span>
                  </div>
                  <div className="p-3">
                    {isDataLoading ? (
                      <p className="px-2 py-8 text-sm text-muted-foreground">Loading bookings...</p>
                    ) : bookings.length === 0 ? (
                      <div className="px-2 py-10 text-center">
                        <Ticket className="mx-auto size-8 text-muted-foreground" />
                        <p className="mt-3 text-sm font-medium">No bookings for this kiosk view</p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Kiosk users only see bookings for products assigned to their team account.
                        </p>
                      </div>
                    ) : (
                      <div className="overflow-hidden rounded-lg border">
                        {bookings.map((booking) => {
                          const customer = booking.customer_id ? customerById.get(booking.customer_id) : undefined;
                          const product = productById.get(booking.product_id);
                          const paxs = booking.adult + booking.child + booking.infant || booking.paxs;

                          return (
                            <article
                              key={booking.id}
                              className="grid min-h-14 grid-cols-[minmax(8rem,1fr)_minmax(10rem,1.2fr)_minmax(9rem,1fr)_4rem_5rem_6rem] items-center gap-3 border-b bg-background px-3 py-2 text-sm last:border-b-0"
                            >
                              <div className="min-w-0">
                                <p className="truncate font-semibold">{booking.booking_reference}</p>
                                <p className="truncate text-xs text-muted-foreground">
                                  {timeLabelFormatter.format(new Date(booking.date_timestamp))}
                                </p>
                              </div>
                              <p className="min-w-0 truncate font-medium">{fullCustomerName(customer)}</p>
                              <p className="min-w-0 truncate text-muted-foreground">
                                {product?.product_name ?? "Unknown product"}
                              </p>
                              <p className="font-semibold">{paxs}</p>
                              <span
                                className={cn(
                                  "inline-flex w-fit rounded-md px-2 py-1 text-xs font-medium",
                                  booking.checked
                                    ? "bg-emerald-50 text-emerald-700"
                                    : "bg-muted text-muted-foreground",
                                )}
                              >
                                {booking.checked ? "In" : "Open"}
                              </span>
                              <p className="truncate text-xs text-muted-foreground">{booking.status}</p>
                            </article>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </section>

                <section className="rounded-xl border bg-card">
                  <div className="border-b px-4 py-3">
                    <h2 className="font-semibold tracking-tight">Kiosk sales</h2>
                    <p className="text-sm text-muted-foreground">Cash and card totals for the selected day.</p>
                  </div>
                  <div className="p-3">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="rounded-lg border bg-background p-3">
                        <p className="text-xs uppercase tracking-wide text-muted-foreground">Total cash sales</p>
                        <p className="mt-1 text-2xl font-semibold">{formatCents(cashTotal)}</p>
                      </div>
                      <div className="rounded-lg border bg-background p-3">
                        <p className="text-xs uppercase tracking-wide text-muted-foreground">Total card sales</p>
                        <p className="mt-1 text-2xl font-semibold">{formatCents(cardTotal)}</p>
                      </div>
                    </div>
                    <div className="mt-3 overflow-hidden rounded-lg border">
                      <div className="grid grid-cols-[1fr_6rem_6rem_1fr] gap-3 border-b bg-muted/40 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        <span>Booking ID</span>
                        <span>Amount</span>
                        <span>Type</span>
                        <span>Product</span>
                      </div>
                      {sales.length === 0 ? (
                        <p className="px-3 py-8 text-sm text-muted-foreground">No kiosk sales yet.</p>
                      ) : (
                        sales.map((sale) => {
                          const booking = bookingById.get(sale.booking_id);
                          const product = productById.get(sale.product_id);

                          return (
                            <article
                              key={sale.id}
                              className="grid min-h-12 grid-cols-[1fr_6rem_6rem_1fr] items-center gap-3 border-b bg-background px-3 py-2 text-sm last:border-b-0"
                            >
                              <span className="min-w-0 truncate">{booking?.booking_reference ?? sale.booking_id}</span>
                              <span className="font-medium">{formatCents(sale.amount_cents)}</span>
                              <span className="text-muted-foreground">{paymentLabel(sale.payment_type)}</span>
                              <span className="min-w-0 truncate text-muted-foreground">
                                {product?.short_name || product?.product_name || "Unknown"}
                              </span>
                            </article>
                          );
                        })
                      )}
                    </div>
                  </div>
                </section>
              </div>
            ) : (
              <form onSubmit={handleCreateBooking} className="rounded-xl border bg-card">
                <div className="border-b px-4 py-3">
                  <h2 className="font-semibold tracking-tight">Add kiosk booking</h2>
                  <p className="text-sm text-muted-foreground">
                    Products are limited to the current account access.
                  </p>
                </div>

                <div className="grid gap-5 p-4 xl:grid-cols-[1.2fr_0.8fr]">
                  <section className="grid gap-4">
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
                      <div className="inline-flex rounded-lg border bg-background p-1">
                        <button
                          type="button"
                          onClick={() => setSaleKind("ticket")}
                          className={cn(
                            "h-9 rounded-md px-5 text-sm font-semibold transition",
                            saleKind === "ticket" ? "bg-indigo-600 text-white" : "text-muted-foreground",
                          )}
                        >
                          Ticket
                        </button>
                        <button
                          type="button"
                          onClick={() => setSaleKind("product")}
                          className={cn(
                            "h-9 rounded-md px-5 text-sm font-semibold transition",
                            saleKind === "product" ? "bg-indigo-600 text-white" : "text-muted-foreground",
                          )}
                        >
                          Product
                        </button>
                      </div>
                      <label className="grid min-w-72 flex-1 gap-1.5 text-sm font-medium">
                        Select product
                        <select
                          required
                          value={productId}
                          onChange={(event) => setProductId(event.target.value)}
                          className={inputClass}
                        >
                          {products.length === 0 ? (
                            <option value="">No allowed products</option>
                          ) : (
                            products.map((product) => (
                              <option key={product.id} value={product.id}>
                                {product.product_name}
                              </option>
                            ))
                          )}
                        </select>
                      </label>
                    </div>

                    <div className="grid gap-3 md:grid-cols-3">
                      {[
                        { key: "adult" as const, label: "Adult", value: adult, price: getProductPriceCents(selectedProduct, "adult") },
                        { key: "child" as const, label: "Child", value: child, price: getProductPriceCents(selectedProduct, "child") },
                        { key: "infant" as const, label: "Free Child", value: infant, price: getProductPriceCents(selectedProduct, "infant") },
                      ].map((item) => (
                        <div key={item.key} className="rounded-lg border bg-background p-4 text-center">
                          <p className="text-lg font-semibold">{item.label}</p>
                          <p className="text-xs text-muted-foreground">{formatCents(item.price)}</p>
                          <div className="mt-4 flex items-center justify-center gap-3">
                            <button
                              type="button"
                              onClick={() => adjustCount(item.key, -1)}
                              aria-label={`Remove ${item.label}`}
                              className="inline-flex size-10 items-center justify-center rounded-md bg-indigo-50 text-indigo-600 transition hover:bg-indigo-100"
                            >
                              <ChevronLeft className="size-6" />
                            </button>
                            <input
                              type="number"
                              min="0"
                              value={item.value}
                              onChange={(event) => {
                                const value = String(parseNonNegativeInteger(event.target.value));
                                if (item.key === "adult") {
                                  setAdult(value);
                                } else if (item.key === "child") {
                                  setChild(value);
                                } else {
                                  setInfant(value);
                                }
                              }}
                              className="h-12 w-16 rounded-md border bg-card text-center text-lg font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                            />
                            <button
                              type="button"
                              onClick={() => adjustCount(item.key, 1)}
                              aria-label={`Add ${item.label}`}
                              className="inline-flex size-10 items-center justify-center rounded-md bg-indigo-50 text-indigo-600 transition hover:bg-indigo-100"
                            >
                              <ChevronRight className="size-6" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className={labelClass}>
                        First name
                        <input
                          required
                          value={firstName}
                          onChange={(event) => setFirstName(event.target.value)}
                          className={inputClass}
                        />
                      </label>
                      <label className={labelClass}>
                        Last name
                        <input
                          value={lastName}
                          onChange={(event) => setLastName(event.target.value)}
                          className={inputClass}
                        />
                      </label>
                      <label className={labelClass}>
                        Phone
                        <input
                          value={phone}
                          onChange={(event) => setPhone(event.target.value)}
                          className={inputClass}
                        />
                      </label>
                      <label className={labelClass}>
                        Email
                        <input
                          type="email"
                          value={email}
                          onChange={(event) => setEmail(event.target.value)}
                          className={inputClass}
                        />
                      </label>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-[12rem_12rem_1fr]">
                      <label className={labelClass}>
                        Date
                        <input
                          type="date"
                          value={bookingDate}
                          onChange={(event) => setBookingDate(event.target.value)}
                          className={inputClass}
                        />
                      </label>
                      <label className={labelClass}>
                        Time
                        {selectedTimeslots.length > 0 ? (
                          <select
                            value={bookingTime}
                            onChange={(event) => setBookingTime(event.target.value)}
                            className={inputClass}
                          >
                            {selectedTimeslots.map((slot) => (
                              <option key={slot} value={slot}>
                                {slot}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type="time"
                            value={bookingTime}
                            onChange={(event) => setBookingTime(event.target.value)}
                            className={inputClass}
                          />
                        )}
                      </label>
                      <div className="rounded-lg border bg-background p-3">
                        <p className="text-xs uppercase tracking-wide text-muted-foreground">Connected account</p>
                        <p className="mt-1 truncate text-sm font-medium">
                          {selectedCompany?.stripe_account_id ?? "No Stripe connected account"}
                        </p>
                        <p
                          className={cn(
                            "mt-1 text-xs",
                            cardPaymentsAvailable ? "text-emerald-700" : "text-muted-foreground",
                          )}
                        >
                          {cardPaymentsAvailable ? "Charges enabled" : "Card charging is not ready for this company"}
                        </p>
                      </div>
                    </div>
                  </section>

                  <aside className="grid content-start gap-4">
                    <section className="rounded-lg border bg-background p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Payment</p>
                      <div className="mt-3 grid gap-2">
                        {paymentOptions.map((option) => {
                          const Icon = option.icon;
                          const disabled = option.value !== "cash" && !cardPaymentsAvailable;

                          return (
                            <button
                              key={option.value}
                              type="button"
                              disabled={disabled}
                              onClick={() => setPaymentType(option.value)}
                              className={cn(
                                "flex h-11 items-center justify-between rounded-md border px-3 text-sm font-semibold transition",
                                paymentType === option.value
                                  ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                                  : "bg-card text-muted-foreground hover:bg-muted",
                                disabled ? "cursor-not-allowed opacity-50" : "",
                              )}
                            >
                              <span className="inline-flex items-center gap-2">
                                <Icon className="size-4" />
                                {option.label}
                              </span>
                              {paymentType === option.value ? <Check className="size-4" /> : null}
                            </button>
                          );
                        })}
                      </div>
                      {selectedCardMethod ? (
                        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                          Card sales need the Stripe Connect server endpoint before we can charge this connected
                          account live.
                        </p>
                      ) : null}
                    </section>

                    <section className="rounded-lg border bg-background p-4">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Total price</p>
                      <p className="mt-2 text-4xl font-semibold tracking-tight">{formatCents(totalCents)}</p>
                      <div className="mt-4 space-y-2 text-sm text-muted-foreground">
                        <div className="flex justify-between">
                          <span>Adult x {adultCount}</span>
                          <span>{formatCents(adultCount * getProductPriceCents(selectedProduct, "adult"))}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Child x {childCount}</span>
                          <span>{formatCents(childCount * getProductPriceCents(selectedProduct, "child"))}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Free Child x {infantCount}</span>
                          <span>{formatCents(infantCount * getProductPriceCents(selectedProduct, "infant"))}</span>
                        </div>
                      </div>
                    </section>
                  </aside>
                </div>

                {formError ? (
                  <p className="mx-4 mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {formError}
                  </p>
                ) : null}

                <div className="flex items-center justify-end gap-3 border-t bg-muted/40 px-4 py-3">
                  <Button type="button" variant="ghost" onClick={resetBookingForm} disabled={isSubmitting}>
                    Clear
                  </Button>
                  <Button type="submit" disabled={!formCanSubmit || isSubmitting}>
                    {isSubmitting ? "Creating..." : "Create cash sale"}
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}

export default function KiosksPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-gradient-to-b from-background via-background to-muted/40">
          <section className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-6">
            <p className="text-sm text-muted-foreground">Loading kiosk...</p>
          </section>
        </main>
      }
    >
      <KiosksContent />
    </Suspense>
  );
}
