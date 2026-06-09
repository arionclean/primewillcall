import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { getCurrentStaff } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { BUSINESS_TZ } from "@/lib/dates";
import { formatPax } from "@/lib/dashboard/queries";
import { cn } from "@/lib/utils";

import { formatPhone } from "../list";

type BookingRow = {
  id: string;
  starts_at: string;
  status: string;
  checked_in_at: string | null;
  pax_adult: number;
  pax_child: number;
  pax_infant: number;
  business_tour: {
    name: string;
    tour: { name: string; color: string | null } | null;
  } | null;
};

type CustomerDetail = {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  business: { name: string } | null;
};

function statusBadge(status: string) {
  if (status === "cancelled") return { label: "Cancelled", tone: "danger" as const };
  if (status === "pending")
    return { label: "Waiting for payment", tone: "warning" as const };
  return null;
}

function whenLabel(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user, staff } = await getCurrentStaff();
  if (!user) redirect("/login");
  if (!staff || !staff.is_active) redirect("/dashboard");
  if (staff.role === "check_in") redirect("/dashboard");

  const { id } = await params;
  const supabase = await getSupabaseServerClient();

  // RLS scopes visibility: a manager only resolves their own customers.
  const { data: customer } = (await supabase
    .from("customers")
    .select("id, full_name, phone, email, business:businesses(name)")
    .eq("id", id)
    .maybeSingle()) as { data: CustomerDetail | null };
  if (!customer) notFound();

  const { data: bookingsData } = await supabase
    .from("bookings")
    .select(
      `id, starts_at, status, checked_in_at, pax_adult, pax_child, pax_infant,
       business_tour:business_tours!bookings_business_tour_id_fkey(
         name, tour:tours(name, color)
       )`,
    )
    .eq("customer_id", id)
    .order("starts_at", { ascending: false });

  const bookings = (bookingsData ?? []) as unknown as BookingRow[];
  const active = bookings.filter((b) => b.status !== "cancelled");
  const totalGuests = active.reduce(
    (s, b) => s + b.pax_adult + b.pax_child + b.pax_infant,
    0,
  );

  const stats = [
    { label: "Bookings", value: bookings.length },
    { label: "Guests", value: totalGuests },
  ];

  return (
    <div className="space-y-6">
      <Link
        href="/customers"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        All customers
      </Link>

      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {customer.full_name}
        </h1>
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
          <span>{formatPhone(customer.phone)}</span>
          {customer.email && <span>{customer.email}</span>}
          {customer.business?.name && <span>{customer.business.name}</span>}
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:max-w-xs">
        {stats.map((s) => (
          <Card key={s.label} className="p-4">
            <p className="text-xs font-medium text-muted-foreground">
              {s.label}
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {s.value.toLocaleString()}
            </p>
          </Card>
        ))}
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Booking history</h2>
        {bookings.length === 0 ? (
          <p className="rounded-xl border py-10 text-center text-sm text-muted-foreground">
            No bookings yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {bookings.map((b) => {
              const tour =
                b.business_tour?.tour?.name ?? b.business_tour?.name ?? "Tour";
              const color = b.business_tour?.tour?.color ?? null;
              const badge = statusBadge(b.status);
              const checked = b.checked_in_at != null;
              return (
                <li
                  key={b.id}
                  className={cn(
                    "rounded-xl border p-4",
                    b.status === "cancelled" && "opacity-75",
                  )}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2 font-medium">
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ background: color ?? "#4f46e5" }}
                      />
                      <span className="truncate">{tour}</span>
                    </span>
                    <div className="flex shrink-0 items-center gap-2">
                      {checked && <Badge tone="success">Checked in</Badge>}
                      {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
                    </div>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 text-sm text-muted-foreground">
                    <span>{whenLabel(b.starts_at)}</span>
                    <span>{formatPax(b)}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
