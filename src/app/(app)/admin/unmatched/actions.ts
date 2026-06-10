"use server";

import { revalidatePath } from "next/cache";

import { getCurrentStaff } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

async function assertOwner() {
  const { staff } = await getCurrentStaff();
  if (!staff || !staff.is_active || staff.role !== "owner") {
    throw new Error("Not permitted");
  }
}

/** Resolve a queued email to a tour: teaches the matcher + assigns the tour to the operator. */
export async function resolveUnmatched(formData: FormData): Promise<void> {
  await assertOwner();
  const queueId = String(formData.get("queueId") ?? "");
  const tourId = String(formData.get("tourId") ?? "");
  if (!queueId || !tourId) return;

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.rpc("resolve_email_match", {
    p_queue_id: queueId,
    p_tour_id: tourId,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/admin/unmatched");
}

/** Dismiss a queued email without resolving it. */
export async function ignoreUnmatched(formData: FormData): Promise<void> {
  await assertOwner();
  const queueId = String(formData.get("queueId") ?? "");
  if (!queueId) return;

  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.rpc("ignore_email_match", {
    p_queue_id: queueId,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/admin/unmatched");
}
