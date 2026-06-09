import { redirect } from "next/navigation";

import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Nested layout for everything under /admin/. Requires an active staff row.
 * Owner-only sections (businesses, staff) layer their own owner check on top
 * via their own nested layouts.
 *
 * The parent (app) layout already handles auth + AppShell, so this layout has
 * no chrome of its own.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/admin");

  const { data: staff } = await supabase
    .from("staff")
    .select("id, role, is_active")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!staff || !staff.is_active) {
    redirect("/dashboard");
  }

  return <>{children}</>;
}
