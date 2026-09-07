import Link from "next/link";
import { redirect } from "next/navigation";

import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { getCurrentStaff } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

import { setAccountPinAction } from "../actions";

type AccountRow = {
  id: string;
  full_name: string;
  email: string;
  is_active: boolean;
  kiosk_slug: string | null;
  pin_required: boolean;
  business: { id: string; name: string; logo_url: string | null } | null;
};

function groupByBusiness(accounts: AccountRow[]) {
  const groups = new Map<
    string,
    { id: string; name: string; logoUrl: string | null; members: AccountRow[] }
  >();
  for (const a of accounts) {
    const id = a.business?.id ?? "prime";
    const name = a.business?.name ?? "Prime";
    const logoUrl = a.business?.logo_url ?? null;
    const group = groups.get(id) ?? { id, name, logoUrl, members: [] };
    group.members.push(a);
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.id === "prime") return -1;
    if (b.id === "prime") return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Accounts: the shared desk logins (role check_in), one per desk or tablet,
 * grouped by business the way the team list always was. Not people: a desk is
 * signed in once and the people who work it type their PIN. The one switch here
 * decides whether that desk asks for a PIN, on its computer and on its tablet
 * alike. Owner only.
 */
export default async function AccountsPage() {
  const { staff: me } = await getCurrentStaff();
  if (me?.role !== "owner") redirect("/admin/staff");

  const supabase = await getSupabaseServerClient();
  const [accRes, kioskRes] = await Promise.all([
    supabase
      .from("staff")
      .select(
        `id, full_name, email, is_active, kiosk_slug, pin_required,
         business:businesses!staff_business_id_fkey(id, name, logo_url)`,
      )
      .eq("role", "check_in")
      .order("created_at", { ascending: true }),
    supabase.from("kiosks").select("slug, name, pin_required"),
  ]);
  if (accRes.error) console.error("[accounts] fetch error:", accRes.error);
  const kioskBySlug = new Map((kioskRes.data ?? []).filter((k) => k.slug).map((k) => [k.slug as string, k]));
  const accounts: AccountRow[] = accRes.data ?? [];

  return (
    <div>
      <header className="mb-6 flex items-end justify-between gap-4">
        <p className="max-w-2xl text-sm text-muted-foreground">
          The logins for shared desks and tablets. A desk is signed in once; the people
          who work it type their own PIN, so every action is recorded under the person.
        </p>
        <Link href="/admin/staff/new?role=check_in" className={cn(buttonVariants({ variant: "default" }))}>
          + Add account
        </Link>
      </header>

      {accRes.error && (
        <p className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          Could not load the accounts. Refresh the page and try again.
        </p>
      )}

      {accounts.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="space-y-8">
          {groupByBusiness(accounts).map((group) => (
            <section key={group.id}>
              <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group.logoUrl ? (
                  // Decorative: the business name sits right next to it.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={group.logoUrl}
                    alt=""
                    className="h-6 w-6 shrink-0 rounded border bg-background object-cover"
                  />
                ) : null}
                {group.name}
              </h2>
              <ul className="space-y-2">
                {group.members.map((a) => {
                  const kiosk = a.kiosk_slug ? kioskBySlug.get(a.kiosk_slug) : undefined;
                  const pinOn = a.pin_required || Boolean(kiosk?.pin_required);
                  return (
                    <li key={a.id}>
                      <Card className="transition hover:translate-x-0.5">
                        <CardContent className="flex items-center gap-4 py-4">
                          <Link href={`/admin/staff/${a.id}`} className="flex min-w-0 flex-1 items-center gap-4">
                            <Avatar seed={a.email} />
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-medium">{a.full_name}</p>
                              <p className="truncate text-xs text-muted-foreground">
                                {a.email}
                                {kiosk ? ` · Tablet: ${kiosk.name}` : ""}
                              </p>
                            </div>
                          </Link>
                          <div className="flex items-center gap-2">
                            <Badge tone={pinOn ? "success" : "neutral"}>{pinOn ? "Asks for a PIN" : "No PIN"}</Badge>
                            {!a.is_active && <Badge tone="warning">Inactive</Badge>}
                            <form action={setAccountPinAction}>
                              <input type="hidden" name="staff_id" value={a.id} />
                              <input type="hidden" name="on" value={pinOn ? "0" : "1"} />
                              <SubmitButton variant="outline" size="sm">{pinOn ? "Turn PIN off" : "Turn PIN on"}</SubmitButton>
                            </form>
                          </div>
                          <Link href={`/admin/staff/${a.id}`} aria-label={`Edit ${a.full_name}`} className="text-muted-foreground">
                            ›
                          </Link>
                        </CardContent>
                      </Card>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <p className="text-sm text-muted-foreground">No shared accounts yet.</p>
        <Link href="/admin/staff/new?role=check_in" className={cn(buttonVariants({ variant: "default" }))}>
          + Add your first account
        </Link>
      </CardContent>
    </Card>
  );
}
