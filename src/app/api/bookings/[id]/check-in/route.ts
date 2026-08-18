import { NextResponse } from "next/server";

import { getCurrentStaff } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const supabase = await getSupabaseServerClient();

  // Identity + the calling staff row (needed to stamp checked_in_by_staff_id).
  const { user, staff } = await getCurrentStaff();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (!staff || !staff.is_active) {
    return NextResponse.json(
      { error: "Your account isn't set up yet. Ask Prime to add you to the team." },
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
