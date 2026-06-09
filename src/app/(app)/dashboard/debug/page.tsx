import Link from "next/link";
import { redirect } from "next/navigation";

import { getSupabaseServerClient } from "@/lib/supabase/server";

export default async function DashboardDebugPage() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: staff } = await supabase
    .from("staff")
    .select("id, full_name, role, business_id, is_active")
    .eq("user_id", user.id)
    .maybeSingle();

  return (
    <main className="min-h-screen bg-gradient-to-b from-background via-background to-muted/40">
      <section className="mx-auto w-full max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">
          Account debug
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What the server sees for the current session.
        </p>

        <div className="mt-6 rounded-xl border bg-card p-5 shadow-sm">
          <h2 className="text-base font-medium">Signed in</h2>
          <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
            <dt className="text-muted-foreground">Email</dt>
            <dd className="col-span-2">{user.email ?? "(unknown)"}</dd>
            <dt className="text-muted-foreground">Auth ID</dt>
            <dd className="col-span-2 font-mono text-xs">{user.id}</dd>

            <dt className="text-muted-foreground">Staff name</dt>
            <dd className="col-span-2">
              {staff?.full_name ?? "(no staff row linked)"}
            </dd>
            <dt className="text-muted-foreground">Role</dt>
            <dd className="col-span-2">{staff?.role ?? "(none)"}</dd>
            <dt className="text-muted-foreground">Business</dt>
            <dd className="col-span-2">
              {staff?.business_id ?? "all (owner)"}
            </dd>
            <dt className="text-muted-foreground">Active</dt>
            <dd className="col-span-2">
              {staff?.is_active ? "yes" : "no / not linked"}
            </dd>
          </dl>
        </div>

        <p className="mt-6 text-xs text-muted-foreground">
          <Link href="/dashboard" className="underline">
            Back to dashboard
          </Link>
        </p>
      </section>
    </main>
  );
}
