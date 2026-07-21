"use server";

import { revalidatePath } from "next/cache";

import { getCurrentStaff } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export type ReviewFunnelState = { error?: string; saved?: true };

/**
 * The review funnel's only control. The flow itself is fixed (see
 * src/lib/reviews/copy.ts), so this is the single thing an owner can change.
 *
 * Turning it ON is consequential: Xano still runs the same funnel and still
 * receives every inbound SMS through the webhook mirror, so it must not be
 * switched on until that side is stopped. See docs/review-automation.md.
 */
export async function setReviewAutomationEnabledAction(
  enabled: boolean,
): Promise<ReviewFunnelState> {
  const { user, staff } = await getCurrentStaff();
  if (!user || !staff || !staff.is_active || staff.role !== "owner") {
    return { error: "Only the owner can change this." };
  }

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase
    .from("messaging_settings")
    .update({ review_automation_enabled: enabled })
    .eq("id", true);

  if (error) return { error: error.message };

  revalidatePath("/admin/messaging");
  return { saved: true };
}
