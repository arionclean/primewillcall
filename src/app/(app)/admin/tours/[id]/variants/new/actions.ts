"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getSupabaseServerClient } from "@/lib/supabase/server";

export type CreateVariantState = {
  error?: string;
  fieldErrors?: Partial<Record<string, string>>;
};

type TierInput = {
  label: string;
  description: string | null;
  price_cents: number;
  sort_order: number;
};

function dollarsToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function parseTiers(
  formData: FormData,
  fieldErrors: Record<string, string>,
): TierInput[] {
  const tiers: TierInput[] = [];
  for (let i = 0; i < 10; i++) {
    const label = String(formData.get(`tier_${i}_label`) ?? "").trim();
    const priceRaw = String(formData.get(`tier_${i}_price`) ?? "").trim();
    if (!label && !priceRaw) continue;
    if (!label) {
      fieldErrors[`tier_${i}_label`] = "Label required when a price is set.";
      continue;
    }
    const cents = dollarsToCents(priceRaw);
    if (cents === null) {
      fieldErrors[`tier_${i}_price`] = "Enter a number, like 50 or 12.50.";
      continue;
    }
    const description =
      String(formData.get(`tier_${i}_description`) ?? "").trim() || null;
    tiers.push({
      label,
      description,
      price_cents: cents,
      sort_order: (i + 1) * 10,
    });
  }
  return tiers;
}

export async function createVariantAction(
  tourId: string,
  _prev: CreateVariantState,
  formData: FormData,
): Promise<CreateVariantState> {
  const supabase = await getSupabaseServerClient();

  const business_id = String(formData.get("business_id") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();

  const fieldErrors: Record<string, string> = {};
  if (!business_id) fieldErrors.business_id = "Pick a business.";
  if (!name) fieldErrors.name = "Name is required.";

  const tiers = parseTiers(formData, fieldErrors);
  if (tiers.length === 0) {
    fieldErrors.tier_0_label = "Add at least one pax tier.";
  }

  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  const { data: variant, error: vErr } = await supabase
    .from("business_tours")
    .insert({ tour_id: tourId, business_id, name })
    .select("id")
    .single();

  if (vErr) {
    if (vErr.code === "23505") {
      return {
        fieldErrors: {
          business_id: "This business already has a variant of this tour.",
        },
      };
    }
    return { error: vErr.message };
  }

  const rows = tiers.map((t) => ({
    business_tour_id: variant.id,
    label: t.label,
    description: t.description,
    price_cents: t.price_cents,
    sort_order: t.sort_order,
  }));

  const { error: tErr } = await supabase.from("tour_pax_tiers").insert(rows);
  if (tErr) {
    return {
      error: `Variant created but pax tiers failed to save: ${tErr.message}`,
    };
  }

  revalidatePath(`/admin/tours/${tourId}`);
  revalidatePath("/admin/tours");
  redirect(`/admin/tours/${tourId}`);
}
