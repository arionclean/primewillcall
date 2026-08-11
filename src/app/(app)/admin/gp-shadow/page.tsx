import { formatCentsExact } from "@/lib/dashboard/queries";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Owner-only report card for the /gp voucher matcher, graded against live Xano.
 *
 * Every real Groupon voucher Xano processes is replayed through our matcher and
 * the two verdicts are stored side by side in gp_shadow_runs. This page is where
 * you read the score and, more usefully, the disagreements: each one is either a
 * missing alias on our side or a voucher Xano gets wrong.
 *
 * Counts come from the gp_shadow_summary RPC so the aggregation happens in the
 * database. The table below it only ever loads the disagreements, never the
 * whole run.
 */

export const dynamic = "force-dynamic";

const DAYS = 30;

type Summary = {
  total: number;
  agree: number;
  different_product: number;
  ours_only: number;
  xano_only: number;
  both_none: number;
  errors: number;
  fee_mismatches: number;
  passenger_mismatches: number;
  tier_title: number;
  tier_fuzzy: number;
  tier_merchant: number;
  tier_ai: number;
  tier_none: number;
  median_ms: number | null;
};

const VERDICT_LABEL: Record<string, string> = {
  different_product: "Different product",
  ours_only: "We matched, Xano did not",
  xano_only: "Xano matched, we did not",
  both_none: "Neither matched",
  error: "Replay failed",
};

const VERDICT_TONE: Record<string, string> = {
  different_product: "border-red-200 bg-red-50 text-red-700",
  xano_only: "border-amber-200 bg-amber-50 text-amber-800",
  ours_only: "border-sky-200 bg-sky-50 text-sky-800",
  both_none: "border-neutral-200 bg-neutral-50 text-neutral-600",
  error: "border-neutral-200 bg-neutral-50 text-neutral-600",
};

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "good" | "bad";
}) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p
        className={`mt-1 text-2xl font-semibold tabular-nums ${
          tone === "bad" ? "text-red-600" : tone === "good" ? "text-emerald-600" : ""
        }`}
      >
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export default async function GpShadowPage() {
  const supabase = await getSupabaseServerClient();
  const from = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const to = new Date(Date.now() + 86_400_000).toISOString();

  const [{ data: summaryRows, error: sErr }, { data: issues, error: iErr }] =
    await Promise.all([
      supabase.rpc("gp_shadow_summary", { p_from: from, p_to: to }),
      supabase
        .from("gp_shadow_runs")
        .select(
          "id, created_at, verdict, xano_product, xano_fee_cents, xano_passengers, xano_match_score, ours_product, ours_fee_cents, ours_passengers, ours_match_method, ours_reason, review_note",
        )
        .neq("verdict", "agree")
        .gte("created_at", from)
        .order("created_at", { ascending: false })
        .limit(100),
    ]);

  const s = (Array.isArray(summaryRows) ? summaryRows[0] : summaryRows) as Summary | undefined;
  const total = s?.total ?? 0;
  const wrong = s?.different_product ?? 0;
  // Agreement is only meaningful where BOTH systems picked a product. Counting
  // "Xano did not match" as a disagreement would punish us for the cases we
  // handle and Xano does not, which is backwards.
  const bothPicked = (s?.agree ?? 0) + wrong;
  const agreementPct = bothPicked > 0 ? Math.round(((s?.agree ?? 0) / bothPicked) * 100) : 0;
  const deterministic =
    (s?.tier_title ?? 0) + (s?.tier_fuzzy ?? 0) + (s?.tier_merchant ?? 0);
  const matched = deterministic + (s?.tier_ai ?? 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Groupon matcher vs Xano</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every real Groupon voucher Xano handles is replayed through the new
          matcher and the two answers are compared. Nothing is written to Xano and
          no bookings are created. Last {DAYS} days.
        </p>
      </div>

      {sErr ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Could not load the summary: {sErr.message}
        </p>
      ) : total === 0 ? (
        <p className="rounded-md border border-dashed bg-muted/30 px-3 py-3 text-sm text-muted-foreground">
          No vouchers compared yet. Once Xano starts forwarding them, the score
          shows up here.
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Stat
              label="Vouchers compared"
              value={String(total)}
              hint={s?.errors ? `${s.errors} failed to replay` : undefined}
            />
            <Stat
              label="Agreement"
              value={bothPicked > 0 ? `${agreementPct}%` : "-"}
              hint={`${s?.agree ?? 0} of ${bothPicked} where both picked a product`}
            />
            <Stat
              label="Wrong product"
              value={String(wrong)}
              tone={wrong > 0 ? "bad" : "good"}
              hint="We and Xano picked different products"
            />
            <Stat
              label="We caught, Xano missed"
              value={String(s?.ours_only ?? 0)}
              hint={`${s?.xano_only ?? 0} the other way · ${s?.both_none ?? 0} neither`}
            />
            <Stat
              label="Median time"
              value={s?.median_ms ? `${(s.median_ms / 1000).toFixed(1)}s` : "-"}
              hint="Our matcher, per voucher"
            />
          </div>

          <div className="rounded-lg border bg-card p-4">
            <p className="text-sm font-medium">How we matched</p>
            <p className="mt-1 text-xs text-muted-foreground">
              The first three are deterministic. Vouchers that reach the model
              cost more, take longer, and are the ones worth turning into aliases.
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
              {[
                ["Exact title", s?.tier_title ?? 0],
                ["Fuzzy title", s?.tier_fuzzy ?? 0],
                ["Storefront", s?.tier_merchant ?? 0],
                ["Model (AI)", s?.tier_ai ?? 0],
                ["No match", s?.tier_none ?? 0],
              ].map(([label, n]) => (
                <div key={String(label)}>
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="text-lg font-semibold tabular-nums">{String(n)}</dd>
                </div>
              ))}
            </dl>
            {matched > 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">
                {Math.round((deterministic / matched) * 100)}% of matches needed no
                AI.
                {s?.fee_mismatches ? ` ${s.fee_mismatches} fee mismatch(es).` : ""}
                {s?.passenger_mismatches
                  ? ` ${s.passenger_mismatches} passenger-count mismatch(es).`
                  : ""}
              </p>
            ) : null}
          </div>
        </>
      )}

      <div>
        <h2 className="text-sm font-medium">Needs a look</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Everything except a clean agreement. &quot;Neither matched&quot; is
          usually another operator&apos;s voucher and is fine.
        </p>

        {iErr ? (
          <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            Could not load: {iErr.message}
          </p>
        ) : (issues ?? []).length === 0 ? (
          <p className="mt-3 rounded-md border border-dashed bg-muted/30 px-3 py-3 text-sm text-muted-foreground">
            Nothing to review. Every compared voucher agreed with Xano.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[46rem] text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Outcome</th>
                  <th className="px-3 py-2 font-medium">Xano</th>
                  <th className="px-3 py-2 font-medium">Ours</th>
                  <th className="px-3 py-2 font-medium">Why</th>
                </tr>
              </thead>
              <tbody>
                {(issues ?? []).map((r) => (
                  <tr key={r.id} className="border-t align-top">
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                      {new Intl.DateTimeFormat("en-US", {
                        timeZone: "America/New_York",
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      }).format(new Date(r.created_at))}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-block rounded-full border px-2 py-0.5 text-xs ${
                          VERDICT_TONE[r.verdict] ?? "border-neutral-200 bg-neutral-50"
                        }`}
                      >
                        {VERDICT_LABEL[r.verdict] ?? r.verdict}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {r.xano_product ? (
                        <>
                          <span className="font-medium">{r.xano_product}</span>
                          <span className="block text-xs text-muted-foreground">
                            {r.xano_fee_cents !== null
                              ? formatCentsExact(r.xano_fee_cents)
                              : "no fee"}
                            {r.xano_passengers !== null
                              ? ` · ${r.xano_passengers} pax`
                              : ""}
                            {r.xano_match_score !== null
                              ? ` · score ${Number(r.xano_match_score).toFixed(2)}`
                              : ""}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">no match</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {r.ours_product ? (
                        <>
                          <span className="font-medium">{r.ours_product}</span>
                          <span className="block text-xs text-muted-foreground">
                            {r.ours_fee_cents !== null
                              ? formatCentsExact(r.ours_fee_cents)
                              : "no fee"}
                            {r.ours_passengers !== null
                              ? ` · ${r.ours_passengers} pax`
                              : ""}
                            {r.ours_match_method ? ` · ${r.ours_match_method}` : ""}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">no match</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {r.review_note ?? r.ours_reason ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
