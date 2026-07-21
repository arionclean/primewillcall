import Link from "next/link";
import { redirect } from "next/navigation";

import { getCurrentStaff } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { resolveUnmatched, ignoreUnmatched } from "./actions";

const BUSINESS_TZ = "America/New_York";

/** How many queue rows to render at once, and how far "Show more" can go. */
const PAGE_SIZE = 25;
const MAX_SHOW = 500;

/**
 * The two review lanes. They differ by how much damage an unresolved row does:
 *
 *  - urgent: nothing was matched (or the AI was not confident). The booking is
 *    NOT on the right tour until a human picks one. Work these first.
 *  - soft ('verify'): the AI matched with high confidence and the booking
 *    already uses that product. Resolving only confirms it and writes the
 *    permanent rule, so these can wait.
 */
const LANES = {
  urgent: {
    status: "urgent" as const,
    label: "Urgent",
    blurb:
      "Nothing matched, or the AI was not confident. These bookings are not on the right tour until you pick one.",
  },
  soft: {
    status: "verify" as const,
    label: "Needs confirming",
    blurb:
      "The AI matched these and the booking already uses that product. Confirming just makes it a permanent rule for future emails.",
  },
};

type LaneKey = keyof typeof LANES;

const REASON_META: Record<string, { label: string; tone: "warning" | "info" | "danger" }> = {
  needs_assignment: { label: "Needs assignment", tone: "warning" },
  ai_classified: { label: "AI suggested", tone: "info" },
  no_match: { label: "No match", tone: "danger" },
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
 * Owner-only review queue for OTA emails the matcher could not place, split
 * into Urgent (needs a decision) and Needs confirming (AI already applied it).
 * Resolving teaches the matcher (writes a name alias), assigns the tour to the
 * operator, and corrects the live booking, all in one step (resolve_email_match).
 */
export default async function UnmatchedPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string; tab?: string }>;
}) {
  const { user, staff } = await getCurrentStaff();
  if (!user) redirect("/login?next=/admin/unmatched");
  if (!staff || !staff.is_active) redirect("/dashboard");
  if (staff.role !== "owner") redirect("/dashboard");

  const { show, tab } = await searchParams;
  const laneKey: LaneKey = tab === "soft" ? "soft" : "urgent";
  const lane = LANES[laneKey];

  // The queue holds thousands of rows. Render a page at a time: loading them
  // all built a huge DOM (a tour <select> per card) and silently truncated at
  // Supabase's 1000-row read cap, hiding the rest.
  const limit = Math.min(Math.max(Number(show) || PAGE_SIZE, PAGE_SIZE), MAX_SHOW);

  const supabase = await getSupabaseServerClient();
  const [rowsRes, toursRes, bizRes, urgentCountRes, softCountRes] = await Promise.all([
    supabase
      .from("email_match_queue")
      // Only the columns the card renders, so we never pull heavy payloads.
      .select(
        "id, reason, parsed, suggested_tour_id, original_product_name, business_id, booking_channel, supplier, ai_confidence_score",
        { count: "exact" },
      )
      .eq("status", lane.status)
      .order("created_at", { ascending: false })
      .range(0, limit - 1),
    supabase.from("tours").select("id, name").eq("is_active", true).order("name"),
    supabase.from("businesses").select("id, name"),
    supabase
      .from("email_match_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "urgent"),
    supabase
      .from("email_match_queue")
      .select("id", { count: "exact", head: true })
      .eq("status", "verify"),
  ]);

  const rows = rowsRes.data ?? [];
  const totalCount = rowsRes.count ?? rows.length;
  const hasMore = rows.length < totalCount;
  const tours = toursRes.data ?? [];
  const tourName = new Map(tours.map((t) => [t.id, t.name]));
  const bizName = new Map((bizRes.data ?? []).map((b) => [b.id, b.name]));
  const counts: Record<LaneKey, number> = {
    urgent: urgentCountRes.count ?? 0,
    soft: softCountRes.count ?? 0,
  };

  return (
    <div>
      <header className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight">Unrecognized bookings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          OTA emails the matcher could not place. Your choice is remembered, so the same
          product matches automatically next time.
        </p>
      </header>

      <div role="tablist" aria-label="Review lanes" className="mb-4 flex gap-1 border-b">
        {(Object.keys(LANES) as LaneKey[]).map((key) => {
          const active = key === laneKey;
          return (
            <Link
              key={key}
              href={key === "urgent" ? "/admin/unmatched" : `/admin/unmatched?tab=${key}`}
              role="tab"
              aria-selected={active}
              scroll={false}
              className={cn(
                "-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition",
                active
                  ? "border-indigo-600 text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {LANES[key].label}
              {counts[key] > 0 ? (
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-xs",
                    key === "urgent"
                      ? "bg-red-100 text-red-700"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {counts[key].toLocaleString()}
                </span>
              ) : null}
            </Link>
          );
        })}
      </div>

      <p className="mb-4 text-sm text-muted-foreground">{lane.blurb}</p>

      {rows.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="text-sm text-muted-foreground">
            {laneKey === "urgent"
              ? "Nothing urgent. Every booking found its tour."
              : "Nothing to confirm right now."}
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Showing {rows.length} of {totalCount.toLocaleString()}.
          </p>

          {rows.map((row) => {
            const meta = REASON_META[row.reason] ?? {
              label: row.reason,
              tone: "warning" as const,
            };
            const parsed = (row.parsed ?? {}) as Record<string, unknown>;
            const guest = (parsed.customerName as string | null) ?? "Guest";
            const startsAt = (parsed.startsAtUtc as string | null) ?? null;
            const pax = typeof parsed.paxs === "number" ? (parsed.paxs as number) : null;
            const suggested = row.suggested_tour_id
              ? tourName.get(row.suggested_tour_id) ?? null
              : null;
            const score =
              typeof row.ai_confidence_score === "number" ? row.ai_confidence_score : null;

            return (
              <Card key={row.id} className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                      {score != null ? (
                        <Badge tone={score >= 0.85 ? "success" : "warning"}>
                          {Math.round(score * 100)}% confident
                        </Badge>
                      ) : null}
                      {suggested ? (
                        <span className="text-xs text-muted-foreground">
                          {laneKey === "soft" ? "using" : "suggested"}: {suggested}
                        </span>
                      ) : null}
                    </div>
                    <p className="truncate font-semibold">
                      {row.original_product_name ?? "Unknown product"}
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
                      {laneKey === "soft" ? "Confirm" : "Resolve"}
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

          {hasMore ? (
            <div className="pt-2 text-center">
              <Link
                href={{
                  pathname: "/admin/unmatched",
                  query: {
                    ...(laneKey === "soft" ? { tab: "soft" } : {}),
                    show: Math.min(limit + PAGE_SIZE, MAX_SHOW),
                  },
                }}
                className={cn(buttonVariants({ variant: "outline" }), "h-9")}
                scroll={false}
              >
                Show {Math.min(PAGE_SIZE, totalCount - rows.length)} more
              </Link>
              <p className="mt-2 text-xs text-muted-foreground">
                {(totalCount - rows.length).toLocaleString()} still hidden. Resolving or
                ignoring one removes it from the queue.
              </p>
            </div>
          ) : null}
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
