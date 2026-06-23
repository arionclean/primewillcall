"use server";

import { revalidatePath } from "next/cache";

import { getSupabaseServerClient } from "@/lib/supabase/server";

export type UpdateGrouponFeesState = {
  error?: string;
  fieldErrors?: Partial<Record<string, string>>;
  saved?: true;
};

/** "4.99" -> 499. Empty -> null. Invalid -> the string "invalid". */
function dollarsToCents(raw: string): number | null | "invalid" {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return "invalid";
  return Math.round(n * 100);
}

/**
 * Owner-only write of the per-product Groupon convenience fee. Each product is
 * sent as an indexed triple: bt_id_${i}, bt_enabled_${i} ("1" when Groupon is
 * accepted), bt_fee_${i} (USD). Unchecked => groupon_fee_cents = null (not
 * offered); checked => the entered fee in cents (0 allowed = offered free).
 */
export async function updateGrouponFeesAction(
  _prev: UpdateGrouponFeesState,
  formData: FormData,
): Promise<UpdateGrouponFeesState> {
  const supabase = await getSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { data: current } = await supabase
    .from("staff")
    .select("role, is_active")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!current || !current.is_active || current.role !== "owner") {
    return { error: "Only the owner can change Groupon fees." };
  }

  type Update = { id: string; groupon_fee_cents: number | null };
  const updates: Update[] = [];
  const fieldErrors: Record<string, string> = {};

  for (let i = 0; i < 200; i++) {
    const id = String(formData.get(`bt_id_${i}`) ?? "").trim();
    if (!id) continue;
    const enabled = formData.get(`bt_enabled_${i}`) === "1";
    if (!enabled) {
      updates.push({ id, groupon_fee_cents: null });
      continue;
    }
    const cents = dollarsToCents(String(formData.get(`bt_fee_${i}`) ?? ""));
    if (cents === "invalid") {
      fieldErrors[`fee_${i}`] = "Enter a fee, like 4.99 or 0.";
      continue;
    }
    updates.push({ id, groupon_fee_cents: cents ?? 0 });
  }

  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };
  if (updates.length === 0) return { error: "Nothing to save." };

  const results = await Promise.all(
    updates.map((u) =>
      supabase
        .from("business_tours")
        .update({ groupon_fee_cents: u.groupon_fee_cents })
        .eq("id", u.id),
    ),
  );
  for (const r of results) {
    if (r.error) {
      if (r.error.code === "42501" || /row-level security/i.test(r.error.message)) {
        return { error: "You don't have permission to change Groupon fees." };
      }
      return { error: `Could not save: ${r.error.message}` };
    }
  }

  revalidatePath("/admin/groupon");
  return { saved: true };
}
