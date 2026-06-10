import { redirect } from "next/navigation";

import { getCurrentStaff } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { resolveUnmatched, ignoreUnmatched } from "./actions";

const BUSINESS_TZ = "America/New_York";

const REASON_META: Record<
  string,
  { label: string; tone: "warning" | "info" | "danger"; hint: string }
> = {
  needs_assignment: {
    label: "Needs assignment",
    tone: "warning",
    hint: "Product recognized, but this operator is not set up to run it yet.",
  },
  ai_classified: {
    label: "AI suggested",
    tone: "info",
    hint: "The AI proposed a tour. Confirm it or pick the right one.",
  },
  no_match: {
    label: "No match",
    tone: "danger",
    hint: "Could not be matched automatically. Pick the tour.",
  },
};

function fmtDate(iso: string | null): string {
  if (!iso) return "no date";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "no date";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

/**
 * Owner-only review queue for OTA emails the matcher could not place: products
 * not recognized, AI guesses to confirm, or tours an operator is not assigned.
 * Resolving teaches the matcher (adds a name alias) and assigns the tour to the
 * operator, all in one step (the resolve_email_match RPC).
 */
export default async function UnmatchedPage() {
  const { user, staff } = await getCurrentStaff();
  if (!user) redirect("/login?next=/admin/unmatched");
  if (!staff || !staff.is_active) redirect("/dashboard");
  if (staff.role !== "owner") redirect("/dashboard");

  const supabase = await getSupabaseServerClient();
  const [rowsRes, toursRes, bizRes] = await Promise.all([
    supabase
      .from("email_match_queue")
      .select("*")
      .in("status", ["urgent", "verify"])
      .order("created_at", { ascending: false }),
    supabase.from("tours").select("id, name").eq("is_active", true).order("name"),
    supabase.from("businesses").select("id, name"),
  ]);

  const rows = rowsRes.data ?? [];
  const tours = toursRes.data ?? [];
  const tourName = new Map(tours.map((t) => [t.id, t.name]));
  const bizName = new Map((bizRes.data ?? []).map((b) => [b.id, b.name]));

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Unrecognized bookings
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          OTA emails the matcher could not place. Pick the tour to resolve each
          one. Your choice is remembered, so the same product matches
          automatically next time.
        </p>
      </header>

      {rows.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="text-sm text-muted-foreground">
            All caught up. Nothing needs review.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const meta = REASON_META[row.reason] ?? {
              label: row.reason,
              tone: "warning" as const,
              hint: "",
            };
            const parsed = (row.parsed ?? {}) as Record<string, unknown>;
            const guest = (parsed.customerName as string | null) ?? "Guest";
            const startsAt = (parsed.startsAtUtc as string | null) ?? null;
            const pax =
              typeof parsed.paxs === "number" ? (parsed.paxs as number) : null;
            const suggested = row.suggested_tour_id
              ? tourName.get(row.suggested_tour_id) ?? null
              : null;

            return (
              <Card key={row.id} className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="mb-1 flex items-center gap-2">
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                      {suggested && (
                        <span className="text-xs text-muted-foreground">
                          suggested: {suggested}
                        </span>
                      )}
                    </div>
                    <p className="truncate font-semibold">
                      {row.original_product_name ?? "Unknown product"}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {meta.hint}
                    </p>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    {row.business_id
                      ? bizName.get(row.business_id) ?? "Unknown operator"
                      : "Unknown operator"}
                  </div>
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
                  <Field label="Source" value={row.booking_channel ?? row.supplier} />
                  <Field label="Guest" value={guest} />
                  <Field label="Date" value={fmtDate(startsAt)} />
                  <Field label="Pax" value={pax != null ? String(pax) : "—"} />
                </dl>

                <div className="mt-4 flex flex-wrap items-end gap-2 border-t pt-4">
                  <form action={resolveUnmatched} className="flex items-end gap-2">
                    <input type="hidden" name="queueId" value={row.id} />
                    <label className="grid gap-1 text-xs font-medium text-muted-foreground">
                      Match to tour
                      <select
                        name="tourId"
                        defaultValue={row.suggested_tour_id ?? ""}
                        required
                        className="h-9 min-w-[14rem] rounded-md border bg-background px-3 text-sm"
                      >
                        <option value="" disabled>
                          Choose a tour…
                        </option>
                        {tours.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="submit"
                      className={cn(buttonVariants({ variant: "default" }), "h-9")}
                    >
                      Resolve
                    </button>
                  </form>
                  <form action={ignoreUnmatched}>
                    <input type="hidden" name="queueId" value={row.id} />
                    <button
                      type="submit"
                      className={cn(buttonVariants({ variant: "outline" }), "h-9")}
                    >
                      Ignore
                    </button>
                  </form>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate">{value || "—"}</dd>
    </div>
  );
}
