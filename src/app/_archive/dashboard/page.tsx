"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Activity,
  ArrowUpRight,
  CalendarPlus,
  Check,
  Flame,
  LayoutDashboard,
  Monitor,
  Package,
  Receipt,
  Settings,
  TrendingDown,
  TrendingUp,
  UserMinus,
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
  name_variations: string[] | null;
};

type BookingMetricRow = {
  id: string;
  date_timestamp: string;
  paxs: number;
  checked: boolean;
  product_id: string;
  customer_id: string | null;
};

type ChartDayMetric = {
  key: string;
  label: string;
  checkedInPax: number;
  totalPax: number;
};

type DailyMetric = {
  key: string;
  totalPax: number;
  checkedInPax: number;
};

const sidebarItems = [
  { label: "Overview", icon: LayoutDashboard, href: "/dashboard", active: true },
  { label: "Bookings", icon: Receipt, href: "/orders" },
  { label: "Schedule", icon: CalendarPlus, href: "/schedule" },
  { label: "Products", icon: Package, href: "/products" },
  { label: "Kiosks", icon: Monitor, href: "/kiosks" },
  { label: "Team", icon: Users, href: "/team" },
  { label: "Settings", icon: Settings, href: "#" },
];

const monthFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "numeric",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function toIsoDateUtc(date: Date) {
  return date.toISOString().slice(0, 10);
}

function shiftIsoDate(dateIso: string, days: number) {
  const base = new Date(`${dateIso}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return toIsoDateUtc(base);
}

function DashboardContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [bookings, setBookings] = useState<BookingMetricRow[]>([]);
  const [isAnalyticsLoading, setIsAnalyticsLoading] = useState(false);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState(() => {
    const now = new Date();
    const localDate = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return localDate.toISOString().slice(0, 10);
  });
  const productSearch = searchParams.get("q")?.trim() ?? "";

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
          setError(companyError.message);
        }

        const safeCompanies = (companyRows ?? []) as Company[];
        setCompanies(safeCompanies);
        if (safeCompanies.length > 0) {
          setSelectedCompanyId(safeCompanies[0].id);
        }
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Unable to load dashboard.");
      } finally {
        setIsLoading(false);
      }
    };

    void load();
  }, [router]);

  useEffect(() => {
    if (!selectedCompanyId) {
      setProducts([]);
      setBookings([]);
      setSelectedProductIds([]);
      setAnalyticsError(null);
      return;
    }

    let isCancelled = false;

    const loadAnalytics = async () => {
      try {
        setIsAnalyticsLoading(true);
        setAnalyticsError(null);

        const supabase = getSupabaseBrowserClient();
        const [{ data: productRows, error: productError }, { data: bookingRows, error: bookingError }] =
          await Promise.all([
            supabase
              .from("products")
              .select("id, product_name, short_name, name_variations")
              .eq("company_id", selectedCompanyId)
              .order("created_at", { ascending: true }),
            supabase
              .from("bookings")
              .select("id, date_timestamp, paxs, checked, product_id, customer_id")
              .eq("company_id", selectedCompanyId)
              .order("date_timestamp", { ascending: true }),
          ]);

        if (productError) {
          throw new Error(productError.message);
        }
        if (bookingError) {
          throw new Error(bookingError.message);
        }

        if (isCancelled) {
          return;
        }

        const safeProducts = (productRows ?? []) as Product[];
        const safeBookings = ((bookingRows ?? []) as Array<{
          id: string;
          date_timestamp: string;
          paxs: number | null;
          checked: boolean | null;
          product_id: string;
          customer_id: string | null;
        }>).map((row) => ({
          id: row.id,
          date_timestamp: row.date_timestamp,
          paxs: Number(row.paxs ?? 0),
          checked: Boolean(row.checked),
          product_id: row.product_id,
          customer_id: row.customer_id,
        }));

        setProducts(safeProducts);
        setBookings(safeBookings);
        setSelectedProductIds((previous) => {
          const allProductIds = safeProducts.map((product) => product.id);
          if (allProductIds.length === 0) {
            return [];
          }
          if (previous.length === 0) {
            return allProductIds;
          }
          const stillValidSelections = previous.filter((id) => allProductIds.includes(id));
          return stillValidSelections.length > 0 ? stillValidSelections : allProductIds;
        });
      } catch (analyticsLoadError) {
        if (!isCancelled) {
          setAnalyticsError(
            analyticsLoadError instanceof Error
              ? analyticsLoadError.message
              : "Unable to load analytics.",
          );
        }
      } finally {
        if (!isCancelled) {
          setIsAnalyticsLoading(false);
        }
      }
    };

    void loadAnalytics();

    return () => {
      isCancelled = true;
    };
  }, [selectedCompanyId]);

  const selectedProductSet = useMemo(() => new Set(selectedProductIds), [selectedProductIds]);

  const filteredBookings = useMemo(() => {
    if (selectedProductIds.length === 0) {
      return [];
    }
    return bookings.filter((booking) => selectedProductSet.has(booking.product_id));
  }, [bookings, selectedProductIds.length, selectedProductSet]);

  const selectedMonthKey = useMemo(() => selectedDate.slice(0, 7), [selectedDate]);

  const selectedMonthLabel = useMemo(() => {
    const parsed = new Date(`${selectedMonthKey}-01T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      return selectedMonthKey;
    }
    return monthFormatter.format(parsed);
  }, [selectedMonthKey]);

  const chartDailyMetrics = useMemo<ChartDayMetric[]>(() => {
    const [yearToken, monthToken] = selectedMonthKey.split("-");
    const year = Number(yearToken);
    const month = Number(monthToken);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      return [];
    }

    const totalsByDay = new Map<number, { checkedInPax: number; totalPax: number }>();
    for (const booking of filteredBookings) {
      const parsed = new Date(booking.date_timestamp);
      if (Number.isNaN(parsed.getTime())) {
        continue;
      }
      if (parsed.toISOString().slice(0, 7) !== selectedMonthKey) {
        continue;
      }

      const dayOfMonth = parsed.getUTCDate();
      const existing = totalsByDay.get(dayOfMonth) ?? { checkedInPax: 0, totalPax: 0 };
      existing.totalPax += booking.paxs;
      if (booking.checked) {
        existing.checkedInPax += booking.paxs;
      }
      totalsByDay.set(dayOfMonth, existing);
    }

    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return Array.from({ length: daysInMonth }, (_, index) => {
      const day = index + 1;
      const metric = totalsByDay.get(day) ?? { checkedInPax: 0, totalPax: 0 };
      return {
        key: `${selectedMonthKey}-${String(day).padStart(2, "0")}`,
        label: String(day),
        checkedInPax: metric.checkedInPax,
        totalPax: metric.totalPax,
      };
    });
  }, [filteredBookings, selectedMonthKey]);

  const hasChartData = useMemo(
    () => chartDailyMetrics.some((metric) => metric.totalPax > 0),
    [chartDailyMetrics],
  );

  const dailyMetrics = useMemo<DailyMetric[]>(() => {
    const dayMap = new Map<string, { checkedInPax: number; totalPax: number }>();

    for (const booking of filteredBookings) {
      const parsed = new Date(booking.date_timestamp);
      if (Number.isNaN(parsed.getTime())) {
        continue;
      }
      const dayKey = parsed.toISOString().slice(0, 10);
      const existing = dayMap.get(dayKey) ?? { checkedInPax: 0, totalPax: 0 };
      existing.totalPax += booking.paxs;
      if (booking.checked) {
        existing.checkedInPax += booking.paxs;
      }
      dayMap.set(dayKey, existing);
    }

    return Array.from(dayMap.entries())
      .sort(([dayA], [dayB]) => dayA.localeCompare(dayB))
      .map(([key, metric]) => ({
        key,
        checkedInPax: metric.checkedInPax,
        totalPax: metric.totalPax,
      }));
  }, [filteredBookings]);

  const quickStats = useMemo(() => {
    if (filteredBookings.length === 0) {
      return {
        totalCustomers: 0,
        highestDay: 0,
        dailyAverage: 0,
        totalNotChecked: 0,
        lowestDay: 0,
      };
    }

    const totalCustomers = filteredBookings.reduce((sum, booking) => sum + booking.paxs, 0);
    const totalCheckedIn = filteredBookings.reduce(
      (sum, booking) => sum + (booking.checked ? booking.paxs : 0),
      0,
    );
    const totalNotChecked = Math.max(totalCustomers - totalCheckedIn, 0);
    const totalsByDay = dailyMetrics.map((metric) => metric.totalPax);
    const highestDay = totalsByDay.length > 0 ? Math.max(...totalsByDay) : 0;
    const lowestDay = totalsByDay.length > 0 ? Math.min(...totalsByDay) : 0;
    const dailyAverage = dailyMetrics.length > 0 ? Math.round(totalCustomers / dailyMetrics.length) : 0;

    return {
      totalCustomers,
      highestDay,
      dailyAverage,
      totalNotChecked,
      lowestDay,
    };
  }, [dailyMetrics, filteredBookings]);

  const maxChartCheckedIn = useMemo(() => {
    const max = chartDailyMetrics.reduce((currentMax, metric) => Math.max(currentMax, metric.checkedInPax), 0);
    return Math.max(max, 1);
  }, [chartDailyMetrics]);

  const dailyMetricsByDate = useMemo(() => {
    const dayMap = new Map<string, { totalPax: number; checkedInPax: number }>();
    for (const booking of bookings) {
      const parsed = new Date(booking.date_timestamp);
      if (Number.isNaN(parsed.getTime())) {
        continue;
      }
      const dayKey = parsed.toISOString().slice(0, 10);
      const existing = dayMap.get(dayKey) ?? { totalPax: 0, checkedInPax: 0 };
      existing.totalPax += booking.paxs;
      if (booking.checked) {
        existing.checkedInPax += booking.paxs;
      }
      dayMap.set(dayKey, existing);
    }
    return dayMap;
  }, [bookings]);

  const selectedDateMetrics = dailyMetricsByDate.get(selectedDate) ?? {
    totalPax: 0,
    checkedInPax: 0,
  };

  const lastWeekDate = useMemo(() => shiftIsoDate(selectedDate, -7), [selectedDate]);
  const lastWeekMetrics = dailyMetricsByDate.get(lastWeekDate) ?? {
    totalPax: 0,
    checkedInPax: 0,
  };

  const dailyChangePercentage = useMemo(() => {
    if (lastWeekMetrics.totalPax <= 0) {
      return null;
    }
    return ((selectedDateMetrics.totalPax - lastWeekMetrics.totalPax) / lastWeekMetrics.totalPax) * 100;
  }, [lastWeekMetrics.totalPax, selectedDateMetrics.totalPax]);

  const selectedDateLabel = useMemo(() => {
    const parsed = new Date(`${selectedDate}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      return selectedDate;
    }
    return dateFormatter.format(parsed);
  }, [selectedDate]);

  const topProductCards = useMemo(() => {
    const totals = new Map<string, number>();
    for (const booking of bookings) {
      const parsed = new Date(booking.date_timestamp);
      if (Number.isNaN(parsed.getTime())) {
        continue;
      }
      if (parsed.toISOString().slice(0, 10) !== selectedDate) {
        continue;
      }
      totals.set(booking.product_id, (totals.get(booking.product_id) ?? 0) + booking.paxs);
    }

    const normalizedSearch = productSearch.toLowerCase();
    const productNameById = new Map(
      products.map((product) => [product.id, product.product_name || product.short_name || "Unnamed product"]),
    );

    return Array.from(totals.entries())
      .filter(([, count]) => count > 0)
      .map(([productId, count]) => ({
        id: productId,
        name: productNameById.get(productId) ?? "Unknown product",
        count,
      }))
      .filter((product) => product.name.toLowerCase().includes(normalizedSearch))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [bookings, productSearch, products, selectedDate]);

  const toggleProduct = (productId: string) => {
    setSelectedProductIds((current) =>
      current.includes(productId) ? current.filter((id) => id !== productId) : [...current, productId],
    );
  };

  const handleSignOut = async () => {
    const supabase = getSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  };

  if (isLoading) {
    return (
      <main className="min-h-screen bg-gradient-to-b from-background via-background to-muted/40">
        <section className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-6">
          <p className="text-sm text-muted-foreground">Loading dashboard...</p>
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

            <div className="max-w-[220px]">
              <section className="rounded-xl border bg-card p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Date</p>
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(event) => setSelectedDate(event.target.value)}
                  className="mt-1.5 h-9 w-full rounded-md border bg-background px-2 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring/50"
                />
              </section>
            </div>

            <div className="mt-3 grid gap-2 md:grid-cols-2">
              <section className="rounded-xl border bg-card p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Total customers</p>
                <p className="mt-1 text-2xl font-semibold tracking-tight">
                  {selectedDateMetrics.totalPax.toLocaleString()}
                </p>
                <p className="mt-2 flex items-center gap-1.5 text-[11px]">
                  {dailyChangePercentage === null ? (
                    <span className="text-muted-foreground">No last week baseline</span>
                  ) : (
                    <>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 font-medium",
                          dailyChangePercentage >= 0 ? "text-emerald-600" : "text-destructive",
                        )}
                      >
                        <ArrowUpRight
                          className={cn("size-3.5", dailyChangePercentage >= 0 ? "" : "rotate-180")}
                        />
                        {`${dailyChangePercentage >= 0 ? "+" : ""}${dailyChangePercentage.toFixed(1)}%`}
                      </span>
                      <span className="text-muted-foreground">vs last week</span>
                    </>
                  )}
                </p>
              </section>

              <section className="rounded-xl border bg-card p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Checked-in customers</p>
                <p className="mt-1 text-2xl font-semibold tracking-tight">
                  {selectedDateMetrics.checkedInPax.toLocaleString()}
                </p>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  vs {lastWeekMetrics.checkedInPax.toLocaleString()} last week
                </p>
              </section>
            </div>

            <div className="mt-2.5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {topProductCards.map((productCard) => (
                <section key={productCard.id} className="rounded-xl border bg-card p-3">
                  <p className="line-clamp-1 text-base font-medium text-foreground">
                    {productCard.name}
                  </p>
                  <p className="mt-1 text-3xl font-semibold tracking-tight">
                    {productCard.count.toLocaleString()}
                  </p>
                  <Flame className="mt-1 size-3.5 text-amber-500" />
                </section>
              ))}
            </div>

            <p className="mt-1.5 text-xs text-muted-foreground">
              Snapshot date: {selectedDateLabel}
            </p>

            {topProductCards.length === 0 ? (
              <p className="mt-3 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                No products with bookings found on the selected date.
              </p>
            ) : null}

            <section className="mt-4 rounded-xl border bg-card p-4">
              <div className="inline-flex rounded-lg border bg-background px-3 py-1.5">
                <h2 className="text-base font-semibold tracking-tight">Quick analytics</h2>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Users checked per day in {selectedMonthLabel}
              </p>
            
              <div className="mt-3 flex flex-wrap gap-1.5">
                  {products.length === 0 && !isAnalyticsLoading ? (
                    <p className="text-sm text-muted-foreground">No products available yet.</p>
                  ) : (
                    products.map((product) => {
                      const isSelected = selectedProductIds.includes(product.id);

                      return (
                        <button
                          key={product.id}
                          type="button"
                          onClick={() => toggleProduct(product.id)}
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                            isSelected
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border bg-muted text-muted-foreground hover:border-primary/50 hover:text-foreground",
                          )}
                        >
                          <Check className={cn("size-2.5", isSelected ? "opacity-100" : "opacity-0")} />
                          {product.short_name || product.product_name}
                        </button>
                      );
                    })
                  )}
              </div>

              {isAnalyticsLoading ? (
                <div className="mt-6 rounded-lg border bg-background px-4 py-12 text-center text-sm text-muted-foreground">
                  Loading analytics...
                </div>
              ) : null}

              {!isAnalyticsLoading && analyticsError ? (
                <p className="mt-6 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {analyticsError}
                </p>
              ) : null}

              {!isAnalyticsLoading && !analyticsError ? (
                selectedProductIds.length === 0 ? (
                  <div className="mt-6 rounded-lg border bg-background px-4 py-12 text-center text-sm text-muted-foreground">
                    Select at least one product to view analytics.
                  </div>
                ) : (
                  <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_250px]">
                    <div className="rounded-lg border bg-background p-3">
                      {!hasChartData ? (
                        <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
                          No booking data available in {selectedMonthLabel} for the selected products.
                        </div>
                      ) : (
                        <div
                          className="grid h-[230px] items-end gap-1"
                          style={{
                            gridTemplateColumns: `repeat(${chartDailyMetrics.length}, minmax(0, 1fr))`,
                          }}
                        >
                          {chartDailyMetrics.map((metric, index) => {
                            const barHeight =
                              metric.checkedInPax <= 0
                                ? 2
                                : Math.max(6, Math.round((metric.checkedInPax / maxChartCheckedIn) * 170));
                            const metricDate = new Date(`${metric.key}T00:00:00Z`);
                            const metricDateLabel = Number.isNaN(metricDate.getTime())
                              ? metric.key
                              : dateFormatter.format(metricDate);
                            const metricNotChecked = Math.max(metric.totalPax - metric.checkedInPax, 0);
                            const showLabel =
                              index === 0 ||
                              index === chartDailyMetrics.length - 1 ||
                              (index + 1) % 5 === 0;

                            return (
                              <div
                                key={metric.key}
                                className="group relative flex min-w-0 flex-col items-center gap-1"
                                title={`${selectedMonthLabel} ${metric.label}: checked ${metric.checkedInPax.toLocaleString()}, total ${metric.totalPax.toLocaleString()}`}
                              >
                                <div className="pointer-events-none absolute -top-20 z-20 w-36 rounded-md border bg-background px-2 py-1.5 text-[10px] text-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                                  <p className="font-medium">{metricDateLabel}</p>
                                  <p>Total: {metric.totalPax.toLocaleString()}</p>
                                  <p>Checked-in: {metric.checkedInPax.toLocaleString()}</p>
                                  <p>Not checked: {metricNotChecked.toLocaleString()}</p>
                                </div>
                                <div className="relative flex h-[200px] w-full items-end justify-center rounded-sm border border-dashed border-border/60 bg-muted/20 px-0.5 pb-1">
                                  {metric.checkedInPax > 0 ? (
                                    <span className="absolute top-1 text-[9px] text-muted-foreground">
                                      {metric.checkedInPax.toLocaleString()}
                                    </span>
                                  ) : null}
                                  <div
                                    className="w-full rounded-t-sm bg-primary/85"
                                    style={{ height: `${barHeight}px` }}
                                  />
                                </div>
                                <p
                                  className={cn(
                                    "truncate text-[10px] text-muted-foreground",
                                    showLabel ? "opacity-100" : "opacity-0",
                                  )}
                                >
                                  {metric.label}
                                </p>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    <aside>
                      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Quick stats
                      </h3>
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between rounded-lg border bg-background px-2.5 py-2">
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Users className="size-3.5" />
                            <span>Total customers</span>
                          </div>
                          <span className="text-xs font-semibold">
                            {quickStats.totalCustomers.toLocaleString()}
                          </span>
                        </div>
                        <div className="flex items-center justify-between rounded-lg border bg-background px-2.5 py-2">
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <TrendingUp className="size-3.5" />
                            <span>Highest day</span>
                          </div>
                          <span className="text-xs font-semibold">{quickStats.highestDay.toLocaleString()}</span>
                        </div>
                        <div className="flex items-center justify-between rounded-lg border bg-background px-2.5 py-2">
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Activity className="size-3.5" />
                            <span>Daily average</span>
                          </div>
                          <span className="text-xs font-semibold">{quickStats.dailyAverage.toLocaleString()}</span>
                        </div>
                        <div className="flex items-center justify-between rounded-lg border bg-background px-2.5 py-2">
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <UserMinus className="size-3.5" />
                            <span>Total not checked</span>
                          </div>
                          <span className="text-xs font-semibold">
                            {quickStats.totalNotChecked.toLocaleString()}
                          </span>
                        </div>
                        <div className="flex items-center justify-between rounded-lg border bg-background px-2.5 py-2">
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <TrendingDown className="size-3.5" />
                            <span>Lowest day</span>
                          </div>
                          <span className="text-xs font-semibold">{quickStats.lowestDay.toLocaleString()}</span>
                        </div>
                      </div>
                    </aside>
                  </div>
                )
              ) : null}
            </section>

          </div>
        </div>
      </section>
    </main>
  );
}

export default function DashboardPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-gradient-to-b from-background via-background to-muted/40">
          <section className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-6">
            <p className="text-sm text-muted-foreground">Loading dashboard...</p>
          </section>
        </main>
      }
    >
      <DashboardContent />
    </Suspense>
  );
}
