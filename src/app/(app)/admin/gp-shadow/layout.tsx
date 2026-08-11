import { redirect } from "next/navigation";

import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Owner-only gate for /admin/gp-shadow/*. The shadow test spans every business
 * and carries OCR-derived voucher detail, so it is Prime's view only. RLS on
 * gp_shadow_runs is the backstop.
 */
export default async function GpShadowLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/admin/gp-shadow");

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
