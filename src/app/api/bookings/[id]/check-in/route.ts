import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const supabase = await getSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Find the calling staff row so we can stamp checked_in_by_staff_id.
  const { data: staff, error: staffErr } = await supabase
    .from("staff")
    .select("id, role")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .maybeSingle();
  if (staffErr) {
    return NextResponse.json({ error: staffErr.message }, { status: 500 });
  }
  if (!staff) {
    return NextResponse.json(
      { error: "No active staff row linked to your auth user" },
      { status: 403 },
    );
  }

  // Check-in is independent of payment status; only stamp the check-in fields.
  const { data, error } = await supabase
    .from("bookings")
    .update({
      checked_in_at: new Date().toISOString(),
      checked_in_by_staff_id: staff.id,
    })
    .eq("id", id)
    .select("id, status, checked_in_at, checked_in_by_staff_id")
    .single();

  if (error) {
    // RLS denial returns no row and PGRST116; also surface generic errors.
    return NextResponse.json({ error: error.message }, { status: 403 });
  }

  return NextResponse.json({ booking: data });
}
