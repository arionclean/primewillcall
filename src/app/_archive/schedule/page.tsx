"use client";

import { FormEvent, Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CalendarPlus,
  LayoutDashboard,
  Monitor,
  MoreHorizontal,
  Package,
  Receipt,
  Settings,
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

type Product = {
  id: string;
  product_name: string;
  short_name: string;
};

const sidebarItems = [
  { label: "Overview", icon: LayoutDashboard, href: "/dashboard" },
  { label: "Bookings", icon: Receipt, href: "/orders" },
  { label: "Schedule", icon: CalendarPlus, href: "/schedule", active: true },
  { label: "Products", icon: Package, href: "/products" },
  { label: "Kiosks", icon: Monitor, href: "/kiosks" },
  { label: "Team", icon: Users, href: "/team" },
  { label: "Settings", icon: Settings, href: "#" },
];

const KNOWN_CHANNELS = ["GetYourGuide", "Viator", "Groupon"] as const;

function todayLocalIsoDate() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function inferBookingChannel(supplier: string) {
  const normalized = supplier.trim().toLowerCase();
  if (!normalized) {
    return "manual";
  }
  for (const channel of KNOWN_CHANNELS) {
    if (normalized === channel.toLowerCase()) {
      return channel.toLowerCase();
    }
  }
  return "manual";
}

function generateReference(prefix: string) {
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  const stamp = Date.now().toString(36).toUpperCase().slice(-4);
  return `${prefix}-${stamp}${random}`;
}

function parseNonNegativeInt(value: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function ScheduleContent() {
  const router = useRouter();

  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [suppliers, setSuppliers] = useState<string[]>([]);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [adult, setAdult] = useState("");
  const [child, setChild] = useState("");
  const [infant, setInfant] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [productId, setProductId] = useState("");
  const [supplier, setSupplier] = useState("");
  const [checkInNow, setCheckInNow] = useState(false);
  const [date, setDate] = useState(todayLocalIsoDate);
  const [time, setTime] = useState("");
  const [dueAmount, setDueAmount] = useState("");
  const [note, setNote] = useState("");
  const [showNote, setShowNote] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [showAllSuppliers, setShowAllSuppliers] = useState(false);
  const [bookingReference, setBookingReference] = useState("");
  const [status, setStatus] = useState("confirmed");

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

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
          setLoadError(companyError.message);
        }

        const safeCompanies = (companyRows ?? []) as Company[];
        setCompanies(safeCompanies);
        if (safeCompanies.length > 0) {
          setSelectedCompanyId(safeCompanies[0].id);
        }
      } catch (caught) {
        setLoadError(caught instanceof Error ? caught.message : "Unable to load schedule.");
      } finally {
        setIsLoading(false);
      }
    };

    void load();
  }, [router]);

  useEffect(() => {
    if (!selectedCompanyId) {
      setProducts([]);
      setSuppliers([]);
      setProductId("");
      return;
    }

    let cancelled = false;

    const loadCompanyData = async () => {
      const supabase = getSupabaseBrowserClient();
      const [{ data: productRows, error: productError }, { data: supplierRows, error: supplierError }] =
        await Promise.all([
          supabase
            .from("products")
            .select("id, product_name, short_name")
            .eq("company_id", selectedCompanyId)
            .order("created_at", { ascending: true }),
          supabase
            .from("bookings")
            .select("supplier")
            .eq("company_id", selectedCompanyId)
            .order("created_at", { ascending: false })
            .limit(1000),
        ]);

      if (cancelled) {
        return;
      }

      if (productError) {
        setLoadError(productError.message);
      } else {
        const safeProducts = (productRows ?? []) as Product[];
        setProducts(safeProducts);
        setProductId((current) => current || safeProducts[0]?.id || "");
      }

      if (!supplierError) {
        const counts = new Map<string, number>();
        for (const row of (supplierRows ?? []) as Array<{ supplier: string | null }>) {
          const value = row.supplier?.trim();
          if (!value) {
            continue;
          }
          counts.set(value, (counts.get(value) ?? 0) + 1);
        }
        for (const channel of KNOWN_CHANNELS) {
          if (!counts.has(channel)) {
            counts.set(channel, 0);
          }
        }
        const ranked = Array.from(counts.entries())
          .sort(([nameA, countA], [nameB, countB]) =>
            countB - countA || nameA.localeCompare(nameB),
          )
          .map(([name]) => name);
        setSuppliers(ranked);
      }
    };

    void loadCompanyData();

    return () => {
      cancelled = true;
    };
  }, [selectedCompanyId]);

  const selectedProduct = useMemo(
    () => products.find((product) => product.id === productId) ?? null,
    [productId, products],
  );

  const totalPaxs = useMemo(
    () => parseNonNegativeInt(adult) + parseNonNegativeInt(child) + parseNonNegativeInt(infant),
    [adult, child, infant],
  );

  const canSubmit =
    Boolean(selectedCompanyId) &&
    Boolean(productId) &&
    Boolean(date) &&
    firstName.trim().length > 0 &&
    totalPaxs > 0;

  const resetForm = () => {
    setFirstName("");
    setLastName("");
    setAdult("");
    setChild("");
    setInfant("");
    setPhone("");
    setEmail("");
    setSupplier("");
    setCheckInNow(false);
    setDate(todayLocalIsoDate());
    setTime("");
    setDueAmount("");
    setNote("");
    setShowNote(false);
    setBookingReference("");
    setStatus("confirmed");
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
      setFormError("Pick a company before adding a booking.");
      return;
    }
    if (!productId) {
      setFormError("Pick a product for this booking.");
      return;
    }
    if (!date) {
      setFormError("Pick a date for this booking.");
      return;
    }
    if (totalPaxs <= 0) {
      setFormError("Enter at least one passenger (adult, child, or infant).");
      return;
    }

    const trimmedFirstName = firstName.trim();
    const trimmedLastName = lastName.trim();
    const trimmedPhone = phone.trim();
    const trimmedEmail = email.trim();
    const trimmedSupplier = supplier.trim() || (selectedProduct?.short_name ?? "manual");

    setIsSubmitting(true);

    const supabase = getSupabaseBrowserClient();

    let customerId: string | null = null;
    const hasCustomerDetails =
      Boolean(trimmedFirstName) || Boolean(trimmedLastName) || Boolean(trimmedPhone) || Boolean(trimmedEmail);

    if (hasCustomerDetails) {
      const { data: insertedCustomer, error: customerError } = await supabase
        .from("customers")
        .insert({
          company_id: selectedCompanyId,
          first_name: trimmedFirstName,
          last_name: trimmedLastName,
          phone: trimmedPhone,
          email: trimmedEmail,
          country: "",
        })
        .select("id")
        .single();

      if (customerError) {
        setFormError(`Unable to save customer: ${customerError.message}`);
        setIsSubmitting(false);
        return;
      }

      customerId = insertedCustomer?.id ?? null;
    }

    const timeValue = time || "00:00";
    const dateTimestamp = new Date(`${date}T${timeValue}:00Z`).toISOString();
    const reference = bookingReference.trim() || generateReference("MAN");
    const internalId = generateReference("INT");
    const channel = inferBookingChannel(trimmedSupplier);
    const priceValue = parseNonNegativeInt(dueAmount);

    const { error: bookingError } = await supabase.from("bookings").insert({
      adult: parseNonNegativeInt(adult),
      booking_channel: channel,
      booking_reference: reference,
      checked: checkInNow,
      child: parseNonNegativeInt(child),
      company_id: selectedCompanyId,
      paxs: totalPaxs,
      date_timestamp: dateTimestamp,
      product_id: productId,
      infant: parseNonNegativeInt(infant),
      internal_id: internalId,
      status,
      supplier: trimmedSupplier,
      note: note.trim(),
      check_in_time: checkInNow ? new Date().toISOString() : null,
      customer_id: customerId,
      product_var: "",
      peek: false,
      price: priceValue,
    });

    if (bookingError) {
      setFormError(`Unable to save booking: ${bookingError.message}`);
      setIsSubmitting(false);
      return;
    }

    setSuccessMessage(`Booking ${reference} added.`);
    setIsSubmitting(false);
    resetForm();
  };

  if (isLoading) {
    return (
      <main className="min-h-screen bg-gradient-to-b from-background via-background to-muted/40">
        <section className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-6">
          <p className="text-sm text-muted-foreground">Loading schedule...</p>
        </section>
      </main>
    );
  }

  const inputClass =
    "h-11 w-full rounded-xl border bg-card px-3 text-sm shadow-sm outline-none transition placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50";
  const numericInputClass = cn(inputClass, "text-center");

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

            {loadError ? (
              <p className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {loadError}
              </p>
            ) : null}

            <form onSubmit={handleSubmit} className="rounded-2xl border bg-card/40 p-6 shadow-sm">
              <h1 className="text-center text-3xl font-semibold tracking-tight">Add Booking</h1>

              <div className="mt-6 grid gap-6 lg:grid-cols-2">
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <input
                      type="text"
                      value={firstName}
                      onChange={(event) => setFirstName(event.target.value)}
                      placeholder="First name"
                      className={inputClass}
                    />
                    <input
                      type="text"
                      value={lastName}
                      onChange={(event) => setLastName(event.target.value)}
                      placeholder="Last name (optional)"
                      className={inputClass}
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <input
                      type="number"
                      min={0}
                      value={adult}
                      onChange={(event) => setAdult(event.target.value)}
                      placeholder="Adult"
                      className={numericInputClass}
                    />
                    <input
                      type="number"
                      min={0}
                      value={child}
                      onChange={(event) => setChild(event.target.value)}
                      placeholder="Child"
                      className={numericInputClass}
                    />
                    <input
                      type="number"
                      min={0}
                      value={infant}
                      onChange={(event) => setInfant(event.target.value)}
                      placeholder="Infant"
                      className={numericInputClass}
                    />
                  </div>

                  <input
                    type="tel"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value.replace(/\D+/g, ""))}
                    placeholder="Phone (optional)"
                    className={inputClass}
                  />

                  <input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="Email (optional)"
                    className={inputClass}
                  />

                  <select
                    value={productId}
                    onChange={(event) => setProductId(event.target.value)}
                    className={inputClass}
                  >
                    {products.length === 0 ? (
                      <option value="">No products available</option>
                    ) : (
                      products.map((product) => (
                        <option key={product.id} value={product.id}>
                          {product.product_name || product.short_name}
                        </option>
                      ))
                    )}
                  </select>

                  <label className="flex items-center gap-2 text-sm font-medium text-primary">
                    <input
                      type="checkbox"
                      checked={checkInNow}
                      onChange={(event) => setCheckInNow(event.target.checked)}
                      className="size-4 accent-primary"
                    />
                    Check in this booking now
                  </label>

                  <div className="grid grid-cols-2 gap-3">
                    <input
                      type="date"
                      value={date}
                      onChange={(event) => setDate(event.target.value)}
                      className={inputClass}
                    />
                    <input
                      type="time"
                      value={time}
                      onChange={(event) => setTime(event.target.value)}
                      placeholder="time"
                      className={inputClass}
                    />
                  </div>
                </div>

                <div className="space-y-4">
                  <button
                    type="button"
                    onClick={() => setShowMore((current) => !current)}
                    className={cn(
                      "flex h-11 w-full items-center justify-center gap-2 rounded-xl border bg-card px-3 text-sm font-medium shadow-sm transition hover:border-primary/50",
                      showMore && "border-primary text-primary",
                    )}
                  >
                    <MoreHorizontal className="size-4" />
                    more
                  </button>

                  {showMore ? (
                    <div className="grid gap-3 rounded-xl border bg-background p-3">
                      <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                        Booking reference (optional)
                        <input
                          type="text"
                          value={bookingReference}
                          onChange={(event) => setBookingReference(event.target.value)}
                          placeholder="Auto-generated if blank"
                          className={inputClass}
                        />
                      </label>
                      <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                        Status
                        <select
                          value={status}
                          onChange={(event) => setStatus(event.target.value)}
                          className={inputClass}
                        >
                          <option value="confirmed">Confirmed</option>
                          <option value="pending">Pending</option>
                          <option value="cancelled">Cancelled</option>
                        </select>
                      </label>
                    </div>
                  ) : null}

                  <div>
                    <p className="text-base font-medium text-muted-foreground">Supplier</p>
                    <div className="mt-2 flex flex-col gap-2">
                      {suppliers.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          No suppliers yet — type one below or pick a known channel.
                        </p>
                      ) : (
                        (showAllSuppliers ? suppliers : suppliers.slice(0, 4)).map((supplierName) => {
                          const isSelected = supplier === supplierName;
                          return (
                            <button
                              key={supplierName}
                              type="button"
                              onClick={() => setSupplier(supplierName)}
                              className={cn(
                                "inline-flex w-fit items-center rounded-md border px-3 py-1.5 text-sm transition-colors",
                                isSelected
                                  ? "border-primary bg-primary/15 text-primary"
                                  : "border-transparent bg-indigo-50 text-foreground hover:bg-indigo-100",
                              )}
                            >
                              {supplierName}
                            </button>
                          );
                        })
                      )}
                      {suppliers.length > 4 ? (
                        <button
                          type="button"
                          onClick={() => setShowAllSuppliers((current) => !current)}
                          className="inline-flex w-fit items-center rounded-md px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                        >
                          {showAllSuppliers ? "Show less" : `more (${suppliers.length - 4})`}
                        </button>
                      ) : null}
                    </div>
                    <input
                      type="text"
                      value={supplier}
                      onChange={(event) => setSupplier(event.target.value)}
                      placeholder="Or type a supplier"
                      className={cn(inputClass, "mt-3")}
                    />
                  </div>

                  <input
                    type="number"
                    min={0}
                    value={dueAmount}
                    onChange={(event) => setDueAmount(event.target.value)}
                    placeholder="Due amount (optional)"
                    className={inputClass}
                  />
                </div>
              </div>

              <div className="mt-6 text-center">
                {showNote ? (
                  <textarea
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="Add a note to this booking"
                    className="mx-auto min-h-24 w-full max-w-2xl rounded-xl border bg-card px-3 py-2 text-sm shadow-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowNote(true)}
                    className="text-sm font-medium text-muted-foreground hover:text-foreground"
                  >
                    Add a note to this booking
                  </button>
                )}
              </div>

              {formError ? (
                <p className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {formError}
                </p>
              ) : null}

              {successMessage ? (
                <p className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                  {successMessage}
                </p>
              ) : null}

              <div className="mt-6 flex justify-center">
                <Button
                  type="submit"
                  disabled={isSubmitting || !canSubmit}
                  className="h-12 w-full max-w-md rounded-xl text-base font-semibold"
                >
                  {isSubmitting ? "Adding booking..." : "Add booking"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      </section>
    </main>
  );
}

export default function SchedulePage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-gradient-to-b from-background via-background to-muted/40">
          <section className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-6">
            <p className="text-sm text-muted-foreground">Loading schedule...</p>
          </section>
        </main>
      }
    >
      <ScheduleContent />
    </Suspense>
  );
}
