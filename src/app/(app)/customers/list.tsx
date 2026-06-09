"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export const CUSTOMERS_PAGE = 50;

export type CustomerRow = {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  business_id: string;
  created_at: string;
  business: { name: string } | null;
};

const SELECT =
  "id, full_name, phone, email, business_id, created_at, business:businesses(name)";

/** Format stored phone digits as (XXX) XXX-XXXX; fall back to the raw value. */
export function formatPhone(raw: string | null): string {
  if (!raw) return "—";
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d[0] === "1")
    return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return raw;
}

function joinedLabel(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso));
}

// Strip characters that would break a PostgREST or() filter string.
function sanitize(q: string): string {
  return q.replace(/[,()*%]/g, " ").trim();
}

async function fetchPage(q: string, offset: number): Promise<CustomerRow[]> {
  const sb = getSupabaseBrowserClient();
  let query = sb
    .from("customers")
    .select(SELECT)
    .order("created_at", { ascending: false })
    .range(offset, offset + CUSTOMERS_PAGE - 1);
  const s = sanitize(q);
  if (s) {
    query = query.or(
      `full_name.ilike.*${s}*,phone.ilike.*${s}*,email.ilike.*${s}*`,
    );
  }
  const { data, error } = await query;
  if (error) {
    console.error("[customers] fetch error:", error);
    return [];
  }
  return (data ?? []) as unknown as CustomerRow[];
}

export function CustomersList({
  initial,
  isOwner,
}: {
  initial: CustomerRow[];
  isOwner: boolean;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<CustomerRow[]>(initial);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(initial.length === CUSTOMERS_PAGE);
  const firstRender = useRef(true);

  // Debounced search. Skip the very first run so the server-rendered page stays.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(async () => {
      const next = await fetchPage(q, 0);
      if (cancelled) return;
      setRows(next);
      setHasMore(next.length === CUSTOMERS_PAGE);
      setLoading(false);
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [q]);

  const loadMore = async () => {
    setLoadingMore(true);
    const next = await fetchPage(q, rows.length);
    setRows((prev) => [...prev, ...next]);
    setHasMore(next.length === CUSTOMERS_PAGE);
    setLoadingMore(false);
  };

  const cols = isOwner
    ? "sm:grid-cols-[minmax(0,1.4fr)_9rem_minmax(0,1.4fr)_minmax(0,1fr)_7rem]"
    : "sm:grid-cols-[minmax(0,1.4fr)_9rem_minmax(0,1.6fr)_7rem]";

  return (
    <div className="space-y-4">
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, phone, or email"
          className="pl-9"
          aria-label="Search customers"
        />
      </div>

      {/* Column header (desktop) */}
      <div
        className={cn(
          "hidden gap-4 px-4 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:grid",
          cols,
        )}
      >
        <span>Name</span>
        <span>Phone</span>
        <span>Email</span>
        {isOwner && <span>Business</span>}
        <span className="text-right">Added</span>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-xl border py-12 text-center text-sm text-muted-foreground">
          {loading ? "Searching." : "No customers match that search."}
        </p>
      ) : (
        <ul className={cn("space-y-2", loading && "opacity-50")}>
          {rows.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => router.push(`/customers/${c.id}`)}
                className={cn(
                  "w-full rounded-xl border p-4 text-left transition hover:bg-muted/40",
                  "sm:grid sm:items-center sm:gap-4 sm:p-3.5",
                  cols,
                )}
              >
                {/* Name */}
                <span className="block truncate font-medium">{c.full_name}</span>

                {/* Phone */}
                <span className="mt-1 block text-sm text-muted-foreground sm:mt-0 sm:text-foreground">
                  {formatPhone(c.phone)}
                </span>

                {/* Email */}
                <span className="block truncate text-sm text-muted-foreground">
                  {c.email ?? "—"}
                </span>

                {/* Business (owner only) */}
                {isOwner && (
                  <span className="mt-1 block truncate text-sm text-muted-foreground sm:mt-0">
                    {c.business?.name ?? "—"}
                  </span>
                )}

                {/* Added */}
                <span className="mt-1 block text-xs text-muted-foreground sm:mt-0 sm:text-right">
                  {joinedLabel(c.created_at)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {hasMore && (
        <div className="flex justify-center pt-1">
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="rounded-md border px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:opacity-50"
          >
            {loadingMore ? "Loading." : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
