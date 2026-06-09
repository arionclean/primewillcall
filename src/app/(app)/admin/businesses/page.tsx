import Image from "next/image";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export default async function BusinessesListPage() {
  const supabase = await getSupabaseServerClient();
  const { data: businesses, error } = await supabase
    .from("businesses")
    .select("id, name, logo_url, phone")
    .order("created_at", { ascending: true });

  return (
    <div>
      <header className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Businesses</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Each Prime business is its own tenant for tours, bookings, and customers.
          </p>
        </div>
        <Link
          href="/admin/businesses/new"
          className={cn(buttonVariants({ variant: "default" }))}
        >
          + Add business
        </Link>
      </header>

      {error && (
        <p className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error.message}
        </p>
      )}

      {(!businesses || businesses.length === 0) ? (
        <EmptyState />
      ) : (
        <ul className="space-y-2">
          {businesses.map((b) => (
            <li key={b.id}>
              <Link
                href={`/admin/businesses/${b.id}`}
                className="block transition hover:translate-x-0.5"
              >
                <Card>
                  <CardContent className="flex items-center gap-4 py-4">
                    <LogoAvatar name={b.name} url={b.logo_url} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{b.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {b.phone ?? "No support phone"}
                      </p>
                    </div>
                    <span
                      aria-hidden
                      className="text-muted-foreground"
                    >
                      ›
                    </span>
                  </CardContent>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LogoAvatar({ name, url }: { name: string; url: string | null }) {
  if (url) {
    return (
      <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-md border bg-background">
        <Image
          src={url}
          alt={`${name} logo`}
          fill
          sizes="40px"
          className="object-cover"
        />
      </div>
    );
  }
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">
      {initials || "?"}
    </div>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <p className="text-sm text-muted-foreground">No businesses yet.</p>
        <Link
          href="/admin/businesses/new"
          className={cn(buttonVariants({ variant: "default" }))}
        >
          + Add your first business
        </Link>
      </CardContent>
    </Card>
  );
}
