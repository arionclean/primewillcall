import { redirect } from "next/navigation";

import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Owner-only gate for /admin/groupon/*. Managers and check-in staff get bounced
 * to the dashboard. The Groupon convenience fee is a platform-level setting, so
 * only Prime (owner) manages it.
 */
export default async function GrouponAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/admin/groupon");

  const { data: staff } = await supabase
    .from("staff")
    .select("role, is_active")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!staff || !staff.is_active || staff.role !== "owner") {
    redirect("/dashboard");
  }

  return <>{children}</>;
}
