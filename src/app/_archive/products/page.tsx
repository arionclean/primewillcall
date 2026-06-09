"use client";

import { FormEvent, Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CalendarPlus,
  Check,
  LayoutDashboard,
  MapPin,
  Monitor,
  Package,
  Palette,
  Plus,
  Receipt,
  Settings,
  SlidersHorizontal,
  Users,
  X,
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

type Product = {
  id: string;
  legacy_id: number | null;
  created_at: string;
  groupon_fee: number | string | null;
  product_name: string;
  internal_id: string;
  name_variations: string[] | null;
  company: string;
  price: unknown;
  timeslots: unknown;
  company_id: string;
  short_name: string;
  color: string;
  meeting_point_address: string;
  meeting_point_description: string;
  meeting_point_latitude: number | string | null;
  meeting_point_longitude: number | string | null;
};

type BookingMetricRow = {
  id: string;
  adult: number;
  child: number;
  infant: number;
  paxs: number;
  product_id: string;
};

const sidebarItems = [
  { label: "Overview", icon: LayoutDashboard, href: "/dashboard" },
  { label: "Bookings", icon: Receipt, href: "/orders" },
  { label: "Schedule", icon: CalendarPlus, href: "/schedule" },
  { label: "Products", icon: Package, href: "/products", active: true },
  { label: "Kiosks", icon: Monitor, href: "/kiosks" },
  { label: "Team", icon: Users, href: "/team" },
  { label: "Settings", icon: Settings, href: "#" },
];

const defaultTimeslots = ["09:00", "13:00"];

function parseOptionalNumber(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeDecimalInput(value: string, allowNegative = false) {
  let sanitized = value.replace(/[^\d.-]/g, "");

  if (!allowNegative) {
    sanitized = sanitized.replace(/-/g, "");
  } else {
    sanitized = sanitized.replace(/(?!^)-/g, "");
  }

  const [whole, ...decimalParts] = sanitized.split(".");
  return decimalParts.length === 0 ? whole : `${whole}.${decimalParts.join("")}`;
}

function formatGrouponFee(value: Product["groupon_fee"]) {
  const parsed = Number.parseFloat(String(value ?? 0));
  const amount = Number.isFinite(parsed) ? parsed : 0;

  return `$${amount.toFixed(2)}`;
}

function normalizeTimeslots(timeslots: string[]) {
  return timeslots.map((slot) => slot.trim()).filter(Boolean);
}

function getMetricPaxCount(booking: BookingMetricRow) {
  const splitCount = booking.adult + booking.child + booking.infant;
  return splitCount > 0 ? splitCount : booking.paxs;
}

function ProductsContent() {
  const router = useRouter();

  const [isLoading, setIsLoading] = useState(true);
  const [isProductsLoading, setIsProductsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [isMetricLoading, setIsMetricLoading] = useState(false);
  const [metricError, setMetricError] = useState<string | null>(null);
  const [ytdBookings, setYtdBookings] = useState<BookingMetricRow[]>([]);
  const [isMetricFilterOpen, setIsMetricFilterOpen] = useState(false);
  const [selectedMetricProductIds, setSelectedMetricProductIds] = useState<string[]>([]);

  const [productName, setProductName] = useState("");
  const [shortName, setShortName] = useState("");
  const [grouponFee, setGrouponFee] = useState("0");
  const [color, setColor] = useState("#dff7e7");
  const [adultPrice, setAdultPrice] = useState("0");
  const [childPrice, setChildPrice] = useState("0");
  const [infantPrice, setInfantPrice] = useState("0");
  const [timeslots, setTimeslots] = useState<string[]>([...defaultTimeslots]);
  const [meetingAddress, setMeetingAddress] = useState("");
  const [meetingDescription, setMeetingDescription] = useState("");
  const [meetingLatitude, setMeetingLatitude] = useState("");
  const [meetingLongitude, setMeetingLongitude] = useState("");

  const selectedCompany = useMemo(
    () => companies.find((company) => company.id === selectedCompanyId) ?? null,
    [companies, selectedCompanyId],
  );
  const selectedCompanyLabel = selectedCompany?.name ?? selectedCompany?.email ?? "";
  const currentYear = new Date().getFullYear();

  useEffect(() => {
    const load = async () => {
      try {
        const supabase = getSupabaseBrowserClient();
        const { data: sessionData } = await supabase.auth.getSession();

        if (!sessionData.session) {
          router.replace("/login");
          return;
        }

        const { data: companyRows, error: companyError } = await supabase
          .from("companies")
          .select("id, name, email")
          .eq("user_id", sessionData.session.user.id)
          .order("created_at", { ascending: true });

        if (companyError) {
          throw new Error(companyError.message);
        }

        const safeCompanies = (companyRows ?? []) as Company[];
        setCompanies(safeCompanies);
        setSelectedCompanyId(safeCompanies[0]?.id ?? "");
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : "Unable to load products.");
      } finally {
        setIsLoading(false);
      }
    };

    void load();
  }, [router]);

  useEffect(() => {
    setSelectedMetricProductIds([]);
    setIsMetricFilterOpen(false);
  }, [selectedCompanyId]);

  useEffect(() => {
    if (!selectedCompanyId) {
      setProducts([]);
      return;
    }

    let cancelled = false;

    const loadProducts = async () => {
      setIsProductsLoading(true);
      setLoadError(null);

      try {
        const supabase = getSupabaseBrowserClient();
        const { data, error } = await supabase
          .from("products")
          .select(
            "id, legacy_id, created_at, groupon_fee, product_name, internal_id, name_variations, company, price, timeslots, company_id, short_name, color, meeting_point_address, meeting_point_description, meeting_point_latitude, meeting_point_longitude",
          )
          .eq("company_id", selectedCompanyId)
          .order("created_at", { ascending: false });

        if (error) {
          throw new Error(error.message);
        }

        if (!cancelled) {
          setProducts((data ?? []) as Product[]);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "Unable to load products.");
        }
      } finally {
        if (!cancelled) {
          setIsProductsLoading(false);
        }
      }
    };

    void loadProducts();

    return () => {
      cancelled = true;
    };
  }, [selectedCompanyId]);

  useEffect(() => {
    if (!selectedCompanyId) {
      setYtdBookings([]);
      return;
    }

    let cancelled = false;

    const loadYtdMetric = async () => {
      setIsMetricLoading(true);
      setMetricError(null);

      try {
        const yearStart = new Date(currentYear, 0, 1);
        const now = new Date();
        const supabase = getSupabaseBrowserClient();
        const { data, error } = await supabase
          .from("bookings")
          .select("id, adult, child, infant, paxs, product_id")
          .eq("company_id", selectedCompanyId)
          .gte("date_timestamp", yearStart.toISOString())
          .lte("date_timestamp", now.toISOString());

        if (error) {
          throw new Error(error.message);
        }

        if (!cancelled) {
          setYtdBookings(
            (data ?? []).map((row) => ({
              id: row.id,
              adult: Number(row.adult ?? 0),
              child: Number(row.child ?? 0),
              infant: Number(row.infant ?? 0),
              paxs: Number(row.paxs ?? 0),
              product_id: row.product_id,
            })),
          );
        }
      } catch (error) {
        if (!cancelled) {
          setMetricError(error instanceof Error ? error.message : "Unable to load year-to-date count.");
        }
      } finally {
        if (!cancelled) {
          setIsMetricLoading(false);
        }
      }
    };

    void loadYtdMetric();

    return () => {
      cancelled = true;
    };
  }, [currentYear, selectedCompanyId]);

  const resetForm = () => {
    setProductName("");
    setShortName("");
    setGrouponFee("0");
    setColor("#dff7e7");
    setAdultPrice("0");
    setChildPrice("0");
    setInfantPrice("0");
    setTimeslots([...defaultTimeslots]);
    setMeetingAddress("");
    setMeetingDescription("");
    setMeetingLatitude("");
    setMeetingLongitude("");
  };

  const updateTimeslot = (index: number, value: string) => {
    setTimeslots((current) =>
      current.map((slot, slotIndex) => (slotIndex === index ? value : slot)),
    );
  };

  const addTimeslot = () => {
    setTimeslots((current) => [...current, ""]);
  };

  const removeTimeslot = (index: number) => {
    setTimeslots((current) =>
      current.length <= 1 ? [""] : current.filter((_, slotIndex) => slotIndex !== index),
    );
  };

  const toggleMetricProduct = (productId: string) => {
    setSelectedMetricProductIds((current) =>
      current.includes(productId)
        ? current.filter((currentProductId) => currentProductId !== productId)
        : [...current, productId],
    );
  };

  const openCreateProduct = () => {
    setFormError(null);
    setSuccessMessage(null);
    resetForm();
    setIsCreateOpen(true);
  };

  const closeCreateProduct = () => {
    if (isSubmitting) {
      return;
    }

    setFormError(null);
    setIsCreateOpen(false);
  };

  const handleSignOut = async () => {
    const supabase = getSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    setSuccessMessage(null);

    if (!selectedCompanyId) {
      setFormError("Pick a company before creating a product.");
      return;
    }
    if (!productName.trim()) {
      setFormError("Product name is required.");
      return;
    }
    if (!shortName.trim()) {
      setFormError("Short name is required.");
      return;
    }

    setIsSubmitting(true);

    try {
      const supabase = getSupabaseBrowserClient();
      const payload = {
        product_name: productName.trim(),
        name_variations: [],
        company: selectedCompanyLabel.trim(),
        price: {
          adult: parseOptionalNumber(adultPrice) ?? 0,
          child: parseOptionalNumber(childPrice) ?? 0,
          infant: parseOptionalNumber(infantPrice) ?? 0,
        },
        groupon_fee: parseOptionalNumber(grouponFee) ?? 0,
        timeslots: normalizeTimeslots(timeslots),
        company_id: selectedCompanyId,
        short_name: shortName.trim(),
        color: color.trim() || "#dff7e7",
        pickup_location: meetingAddress.trim(),
        meeting_point_address: meetingAddress.trim(),
        meeting_point_description: meetingDescription.trim(),
        meeting_point_latitude: parseOptionalNumber(meetingLatitude),
        meeting_point_longitude: parseOptionalNumber(meetingLongitude),
      };

      const { data, error } = await supabase
        .from("products")
        .insert(payload)
        .select(
          "id, legacy_id, created_at, groupon_fee, product_name, internal_id, name_variations, company, price, timeslots, company_id, short_name, color, meeting_point_address, meeting_point_description, meeting_point_latitude, meeting_point_longitude",
        )
        .single();

      if (error) {
        throw new Error(error.message);
      }

      setProducts((current) => [data as Product, ...current]);
      setSuccessMessage("Product created.");
      resetForm();
      setIsCreateOpen(false);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Unable to create product.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <main className="min-h-screen bg-gradient-to-b from-background via-background to-muted/40">
        <section className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-6">
          <p className="text-sm text-muted-foreground">Loading products...</p>
        </section>
      </main>
    );
  }

  const inputClass =
    "h-9 w-full rounded-md border bg-background px-3 text-sm outline-none transition placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50";
  const labelClass = "grid gap-1.5 text-sm font-medium";
  const sectionHeadingClass =
    "border-b pb-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground";
  const groupHeadingClass =
    "mb-1 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground";
  const canCreateProduct = Boolean(
    selectedCompanyId && productName.trim() && shortName.trim(),
  );
  const selectedMetricProductSet = new Set(selectedMetricProductIds);
  const ytdCustomerCount = ytdBookings.reduce((total, booking) => {
    if (selectedMetricProductIds.length > 0 && !selectedMetricProductSet.has(booking.product_id)) {
      return total;
    }

    return total + getMetricPaxCount(booking);
  }, 0);
  const metricFilterLabel =
    selectedMetricProductIds.length === 0
      ? "All products"
      : selectedMetricProductIds.length === 1
        ? products.find((product) => product.id === selectedMetricProductIds[0])?.short_name ?? "1 product"
        : `${selectedMetricProductIds.length} products`;

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
            <div className="relative mt-6 rounded-xl bg-muted/60 p-4">
              <div className="flex items-center gap-3">
                <Users className="size-8 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-3xl font-semibold tracking-tight">
                    {isMetricLoading ? "..." : ytdCustomerCount.toLocaleString("en-US")}
                  </p>
                  <p className="text-lg font-semibold leading-none text-emerald-600">{currentYear}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsMetricFilterOpen((isOpen) => !isOpen)}
                  aria-label="Filter year-to-date customers by product"
                  className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground shadow-sm transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <SlidersHorizontal className="size-4" />
                </button>
              </div>
              <p className="mt-2 truncate text-xs text-muted-foreground">{metricFilterLabel}</p>
              {metricError ? (
                <p className="mt-2 text-xs text-destructive">Unable to load count.</p>
              ) : null}
              {isMetricFilterOpen ? (
                <div className="absolute left-0 right-0 top-full z-30 mt-2 rounded-lg border bg-card p-2 shadow-xl">
                  <div className="mb-2 flex items-center justify-between gap-2 px-1">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Product filter
                    </p>
                    <button
                      type="button"
                      onClick={() => setIsMetricFilterOpen(false)}
                      aria-label="Close product filter"
                      className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedMetricProductIds([])}
                    className={cn(
                      "mb-1 flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition",
                      selectedMetricProductIds.length === 0
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-muted",
                    )}
                  >
                    All products
                    {selectedMetricProductIds.length === 0 ? <Check className="size-4" /> : null}
                  </button>
                  <div className="max-h-48 overflow-y-auto">
                    {products.length === 0 ? (
                      <p className="px-2 py-2 text-sm text-muted-foreground">No products found.</p>
                    ) : (
                      products.map((product) => {
                        const isSelected = selectedMetricProductSet.has(product.id);

                        return (
                          <button
                            key={product.id}
                            type="button"
                            onClick={() => toggleMetricProduct(product.id)}
                            className={cn(
                              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition hover:bg-muted",
                              isSelected ? "text-foreground" : "text-muted-foreground",
                            )}
                          >
                            <span
                              className="size-2.5 shrink-0 rounded-full border"
                              style={{ backgroundColor: product.color || "#dff7e7" }}
                              aria-hidden="true"
                            />
                            <span className="min-w-0 flex-1 truncate">{product.short_name}</span>
                            {isSelected ? <Check className="size-4 shrink-0" /> : null}
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              ) : null}
            </div>
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
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Products</p>
                <h1 className="text-3xl font-semibold tracking-tight">Product list</h1>
              </div>
              <Button onClick={openCreateProduct} disabled={!selectedCompanyId}>
                <Plus className="size-4" />
                Add product
              </Button>
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

            <div className="grid gap-5">
              <section className="rounded-xl border bg-card">
                <div className="border-b px-4 py-3">
                  <h2 className="font-semibold tracking-tight">Product list</h2>
                </div>
                <div className="max-h-[calc(100vh-15rem)] overflow-y-auto p-3">
                  {isProductsLoading ? (
                    <p className="px-2 py-6 text-sm text-muted-foreground">Loading products...</p>
                  ) : products.length === 0 ? (
                    <p className="px-2 py-6 text-sm text-muted-foreground">No products created yet.</p>
                  ) : (
                    <div className="overflow-hidden rounded-lg border">
                      {products.map((product) => (
                        <article
                          key={product.id}
                          className="grid min-h-14 grid-cols-[1.5rem_minmax(8rem,1fr)_minmax(10rem,1.4fr)_minmax(8rem,.9fr)_minmax(10rem,1.2fr)] items-center gap-3 border-b bg-background px-3 py-2 text-sm last:border-b-0"
                        >
                          <span
                            className="size-4 rounded border"
                            style={{ backgroundColor: product.color || "#dff7e7" }}
                            aria-hidden="true"
                          />
                          <p className="min-w-0 truncate font-semibold">{product.short_name}</p>
                          <p className="min-w-0 truncate text-muted-foreground">{product.product_name}</p>
                          <p className="min-w-0 truncate text-muted-foreground">
                            Groupon fee {formatGrouponFee(product.groupon_fee)}
                          </p>
                          <p className="flex min-w-0 items-center gap-1 text-muted-foreground">
                            <MapPin className="size-3 shrink-0" />
                            <span className="truncate">
                              {product.meeting_point_address || "No meeting point"}
                            </span>
                          </p>
                        </article>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              {isCreateOpen ? (
                <div
                  className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4 py-6 animate-in fade-in duration-200"
                  role="presentation"
                  onMouseDown={closeCreateProduct}
                >
                  <form
                    onSubmit={handleSubmit}
                    className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border bg-card shadow-2xl animate-in fade-in zoom-in-95 slide-in-from-bottom-4 duration-300"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="product-create-title"
                    onMouseDown={(event) => event.stopPropagation()}
                  >
                <div className="flex items-center justify-between border-b px-4 py-2.5">
                  <h2 id="product-create-title" className="font-semibold tracking-tight">New product</h2>
                  <button
                    type="button"
                    onClick={closeCreateProduct}
                    aria-label="Close add product"
                    className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <X className="size-4" />
                  </button>
                </div>
                <div className="grid gap-4 overflow-y-auto p-3 lg:grid-cols-2">
                  <section className="grid gap-3">
                    <h3 className={sectionHeadingClass}>Product details</h3>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className={labelClass}>
                        Product name
                        <input
                          required
                          value={productName}
                          onChange={(event) => setProductName(event.target.value)}
                          className={inputClass}
                        />
                      </label>
                      <label className={labelClass}>
                        Short name
                        <input
                          required
                          value={shortName}
                          onChange={(event) => setShortName(event.target.value)}
                          className={inputClass}
                        />
                      </label>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[1fr_7rem_5rem]">
                      <label className={labelClass}>
                        Company
                        <span className="flex h-9 w-full items-center rounded-md border bg-muted/50 px-3 text-sm text-muted-foreground">
                          {selectedCompanyLabel || "No company selected"}
                        </span>
                      </label>
                      <label className={labelClass}>
                        Groupon fee
                        <input
                          inputMode="decimal"
                          value={grouponFee}
                          onChange={(event) => setGrouponFee(sanitizeDecimalInput(event.target.value))}
                          className={inputClass}
                        />
                      </label>
                      <label className={labelClass}>
                        Color
                        <span className="flex h-9 items-center gap-2 rounded-md border bg-background px-2">
                          <Palette className="size-4 text-muted-foreground" />
                          <input
                            type="color"
                            value={color}
                            onChange={(event) => setColor(event.target.value)}
                            className="h-7 w-full border-0 bg-transparent p-0"
                          />
                        </span>
                      </label>
                    </div>
                  </section>

                  <section className="grid gap-3">
                    <h3 className={sectionHeadingClass}>Meeting point</h3>
                    <label className={labelClass}>
                      Address
                      <input
                        value={meetingAddress}
                        onChange={(event) => setMeetingAddress(event.target.value)}
                        className={inputClass}
                      />
                    </label>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className={labelClass}>
                        Latitude
                        <input
                          inputMode="decimal"
                          value={meetingLatitude}
                          onChange={(event) =>
                            setMeetingLatitude(sanitizeDecimalInput(event.target.value, true))
                          }
                          className={inputClass}
                        />
                      </label>
                      <label className={labelClass}>
                        Longitude
                        <input
                          inputMode="decimal"
                          value={meetingLongitude}
                          onChange={(event) =>
                            setMeetingLongitude(sanitizeDecimalInput(event.target.value, true))
                          }
                          className={inputClass}
                        />
                      </label>
                    </div>
                    <label className={labelClass}>
                      Description
                      <textarea
                        value={meetingDescription}
                        onChange={(event) => setMeetingDescription(event.target.value)}
                        className="min-h-14 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none transition placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                      />
                    </label>
                  </section>

                  <section className="grid gap-3 lg:col-span-2">
                    <h3 className={sectionHeadingClass}>Structured pricing and schedule</h3>
                    <div className="grid gap-3 lg:grid-cols-2">
                      <fieldset className="grid gap-3">
                        <legend className={groupHeadingClass}>Prices</legend>
                        <div className="grid gap-3 sm:grid-cols-3">
                          <label className={labelClass}>
                            Adult
                            <input
                              inputMode="decimal"
                              value={adultPrice}
                              onChange={(event) => setAdultPrice(sanitizeDecimalInput(event.target.value))}
                              className={inputClass}
                            />
                          </label>
                          <label className={labelClass}>
                            Child
                            <input
                              inputMode="decimal"
                              value={childPrice}
                              onChange={(event) => setChildPrice(sanitizeDecimalInput(event.target.value))}
                              className={inputClass}
                            />
                          </label>
                          <label className={labelClass}>
                            Infant
                            <input
                              inputMode="decimal"
                              value={infantPrice}
                              onChange={(event) => setInfantPrice(sanitizeDecimalInput(event.target.value))}
                              className={inputClass}
                            />
                          </label>
                        </div>
                      </fieldset>
                      <fieldset className="grid gap-3">
                        <legend className={groupHeadingClass}>Timeslots</legend>
                        <div className="grid gap-2">
                          {timeslots.map((slot, index) => (
                            <div
                              key={`timeslot-${index}`}
                              className="grid grid-cols-[minmax(0,1fr)_2.25rem] items-center gap-2"
                            >
                              <input
                                type="time"
                                value={slot}
                                onChange={(event) => updateTimeslot(index, event.target.value)}
                                className={inputClass}
                              />
                              <button
                                type="button"
                                onClick={() => removeTimeslot(index)}
                                aria-label={`Remove timeslot ${index + 1}`}
                                className="inline-flex size-9 items-center justify-center rounded-md border text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                              >
                                <X className="size-4" />
                              </button>
                            </div>
                          ))}
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={addTimeslot}
                          className="h-8 w-fit"
                        >
                          <Plus className="size-4" />
                          Add time
                        </Button>
                      </fieldset>
                    </div>
                  </section>
                </div>

                {formError ? (
                  <p className="mx-4 mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {formError}
                  </p>
                ) : null}
                {successMessage ? (
                  <p className="mx-4 mb-3 flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                    <Check className="size-4" />
                    {successMessage}
                  </p>
                ) : null}

                <div className="flex items-center justify-end gap-3 border-t bg-muted/40 px-4 py-2.5">
                  <Button type="submit" disabled={isSubmitting || !canCreateProduct} className="h-9">
                    {isSubmitting ? "Creating..." : "Create product"}
                  </Button>
                </div>
                  </form>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

export default function ProductsPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-gradient-to-b from-background via-background to-muted/40">
          <section className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-6">
            <p className="text-sm text-muted-foreground">Loading products...</p>
          </section>
        </main>
      }
    >
      <ProductsContent />
    </Suspense>
  );
}
