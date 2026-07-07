import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const ROLE_LABEL = {
  owner: "Owner",
  business_manager: "Business manager",
  check_in: "Check-in staff",
} as const;

const ROLE_TONE = {
  owner: "primary",
  business_manager: "info",
  check_in: "neutral",
} as const;

type StaffRow = {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  role: keyof typeof ROLE_LABEL;
  is_active: boolean;
  user_id: string | null;
  business: { id: string; name: string } | null;
};

function groupByBusiness(staff: StaffRow[]) {
  const groups = new Map<
    string,
    { id: string; name: string; members: StaffRow[] }
  >();
  for (const s of staff) {
    const id = s.business?.id ?? "prime";
    const name = s.business?.name ?? "Prime";
    const group = groups.get(id) ?? { id, name, members: [] };
    group.members.push(s);
    groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.id === "prime") return -1;
    if (b.id === "prime") return 1;
    return a.name.localeCompare(b.name);
  });
}

export default async function StaffListPage() {
  const supabase = await getSupabaseServerClient();
  const { data: staff, error } = await supabase
    .from("staff")
    .select(
      `id, full_name, email, phone, role, is_active, user_id,
       business:businesses!staff_business_id_fkey(id, name)`,
    )
    .order("created_at", { ascending: true });

  return (
    <div>
      <header className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            People who work for Prime. Owners see everything; managers see one
            business; check-in staff see specific tours.
          </p>
        </div>
        <Link
          href="/admin/staff/new"
          className={cn(buttonVariants({ variant: "default" }))}
        >
          + Add team member
        </Link>
      </header>

      {error && (
        <p className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error.message}
        </p>
      )}

      {(!staff || staff.length === 0) ? (
        <EmptyState />
      ) : (
        <div className="space-y-8">
          {groupByBusiness(staff).map((group) => (
            <section key={group.id}>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group.name}
              </h2>
              <ul className="space-y-2">
                {group.members.map((s) => {
                  const initials = s.full_name
                    .split(/\s+/)
                    .filter(Boolean)
                    .slice(0, 2)
                    .map((w) => w[0]?.toUpperCase() ?? "")
                    .join("");
                  return (
                    <li key={s.id}>
                      <Link
                        href={`/admin/staff/${s.id}`}
                        className="block transition hover:translate-x-0.5"
                      >
                        <Card>
                          <CardContent className="flex items-center gap-4 py-4">
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
                              {initials || "?"}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-medium">
                                {s.full_name}
                              </p>
                              <p className="truncate text-xs text-muted-foreground">
                                {s.email}
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge tone={ROLE_TONE[s.role]}>
                                {ROLE_LABEL[s.role]}
                              </Badge>
                              {!s.is_active && (
                                <Badge tone="warning">Inactive</Badge>
                              )}
                            </div>
                            <span aria-hidden className="text-muted-foreground">
                              ›
                            </span>
                          </CardContent>
                        </Card>
                      </Link>
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
        <p className="text-sm text-muted-foreground">No team members yet.</p>
        <Link
          href="/admin/staff/new"
          className={cn(buttonVariants({ variant: "default" }))}
        >
          + Add your first team member
        </Link>
      </CardContent>
    </Card>
  );
}
