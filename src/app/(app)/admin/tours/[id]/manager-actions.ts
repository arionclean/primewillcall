"use server";

import { revalidatePath } from "next/cache";

import { getSupabaseServerClient } from "@/lib/supabase/server";

export type UpdateManagerTourState = {
  error?: string;
  fieldErrors?: Partial<Record<string, string>>;
  saved?: true;
};

function dollarsToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export async function updateManagerTourAction(
  businessTourId: string,
  tourId: string,
  _prev: UpdateManagerTourState,
  formData: FormData,
): Promise<UpdateManagerTourState> {
  const supabase = await getSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { data: current } = await supabase
    .from("staff")
    .select("role, business_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (
    !current ||
    (current.role !== "owner" && current.role !== "business_manager")
  ) {
    return { error: "You do not have permission to update this tour." };
  }

  if (current.role === "business_manager") {
    const { data: ownership } = await supabase
      .from("business_tours")
      .select("business_id")
      .eq("id", businessTourId)
      .maybeSingle();
    if (!ownership || ownership.business_id !== current.business_id) {
      return { error: "You do not have permission to update this tour." };
    }
  }

  const name = String(formData.get("name") ?? "").trim();
  const is_active = formData.get("is_active") === "1";

  const fieldErrors: Record<string, string> = {};
  if (!name) fieldErrors.name = "Name is required.";

  type TierUpdate = {
    id: string;
    description: string | null;
    price_cents: number;
  };
  const tierUpdates: TierUpdate[] = [];

  for (let i = 0; i < 10; i++) {
    const tierId = String(formData.get(`tier_id_${i}`) ?? "").trim();
    if (!tierId) continue;
    const priceRaw = String(formData.get(`tier_price_${i}`) ?? "").trim();
    const cents = dollarsToCents(priceRaw);
    if (cents === null) {
      fieldErrors[`tier_${i}_price`] = "Enter a number, like 50 or 12.50.";
      continue;
    }
    const description =
      String(formData.get(`tier_description_${i}`) ?? "").trim() || null;
    tierUpdates.push({ id: tierId, description, price_cents: cents });
  }

  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const { error: updErr } = await supabase
    .from("business_tours")
    .update({ name, is_active })
    .eq("id", businessTourId);
  if (updErr) return { error: updErr.message };

  const tierResults = await Promise.all(
    tierUpdates.map((t) =>
      supabase
        .from("tour_pax_tiers")
        .update({ description: t.description, price_cents: t.price_cents })
        .eq("id", t.id),
    ),
  );
  for (const r of tierResults) {
    if (r.error) return { error: `Could not save prices: ${r.error.message}` };
  }

  revalidatePath("/admin/tours");
  revalidatePath(`/admin/tours/${tourId}`);
  revalidatePath("/admin");
  return { saved: true };
}
