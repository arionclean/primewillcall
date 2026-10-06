"use server";

import { revalidatePath } from "next/cache";

import { getCurrentStaff } from "@/lib/auth";
import { nyDateISO } from "@/lib/dashboard/queries";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The owner writes on the Cash close screen.
 *
 * A reported figure is never edited in place. What the tablet said stays in
 * `cash_cents` / `commission_cents` so the paper form and the database can still
 * be reconciled years later; the owner's numbers land in the `_corrected`
 * columns, stamped with who and when. `total_cash_cents` is generated from both,
 * so the cash to collect follows on its own.
 *
 * A night nobody closed has no row to correct, so a save creates one,
 * marked `entered_manually` with NULL reported figures: nothing was reported,
 * and a zero there would read as "the desk counted nothing".
 *
 * Owner only, re-checked here on top of the layout gate. RLS is the backstop:
 * `kiosk_closings_owner_all` is the only policy that allows a write at all.
 */

/** Dollars as typed ("1,307.00", "$50") to whole cents, or null when blank. */
function parseMoney(raw: string): number | null | "invalid" {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) return "invalid";
  return Math.round(n * 100);
}

export type CompleteState = { error?: string; saved?: boolean };

/**
 * The owner closing the book on a night. What they typed as received stands;
 * left blank, it is taken as exactly the cash owed, which is the answer on
 * almost every night. Either way the night is marked complete in the same move,
 * and a received that differs from owed stays on the row as a warning.
 *
 * Owed is recomputed here rather than taken from the form. It is the owner's
 * own record either way, but a figure that arrives from a browser is a figure
 * that can be wrong, and this one becomes the account of what was handed over.
 */
export async function completeNight(
  _prev: CompleteState,
  formData: FormData,
): Promise<CompleteState> {
  const { staff } = await getCurrentStaff();
  if (!staff || !staff.is_active || staff.role !== "owner") {
    return { error: "Only the owner can complete a night." };
  }

  const kioskSlug = String(formData.get("kiosk_slug") ?? "");
  const businessDate = String(formData.get("business_date") ?? "");
  const kioskId = String(formData.get("kiosk_id") ?? "");
  const businessId = String(formData.get("business_id") ?? "");
  if (!kioskSlug || !businessDate) return { error: "Missing the night to complete." };
  if (businessDate === nyDateISO()) {
    return { error: "Tonight is still open. Complete it after the close." };
  }

  const supabase = await getSupabaseServerClient();
  const { data, error: readError } = await supabase.rpc("kiosk_cash_reconciliation", {
    p_from: businessDate,
    p_to: businessDate,
  });
  if (readError) return { error: readError.message };

  const night = (data ?? []).find((r) => r.kiosk_slug === kioskSlug);
  if (!night) return { error: "That night is no longer on the books." };

  const owed = night.system_cash_cents - night.effective_commission_cents;
  const now = new Date().toISOString();
  const completed = { reviewed_at: now, reviewed_by: staff.id };
  // Only a blank received is filled in; one the owner typed is their account.
  const fill =
    night.counted_cash_cents_corrected == null
      ? { cash_cents_corrected: owed, corrected_at: now, corrected_by: staff.id }
      : {};

  if (night.closing_id) {
    const { error } = await supabase
      .from("kiosk_closings")
      .update({ ...fill, ...completed })
      .eq("id", night.closing_id);
    if (error) return { error: error.message };
  } else {
    if (!kioskId) return { error: "This night has no kiosk on record." };
    const { error } = await supabase.from("kiosk_closings").insert({
      kiosk_id: kioskId,
      kiosk_slug: kioskSlug,
      business_id: businessId || null,
      business_date: businessDate,
      entered_manually: true,
      cash_cents: null,
      commission_cents: null,
      ...fill,
      ...completed,
    });
    if (error) return { error: error.message };
  }

  revalidatePath("/admin/payments/cash");
  return { saved: true };
}

export type FigureState = { error?: string; saved?: boolean };

/** The figures a row can be edited in place, and the column each one lands in. */
const FIGURE_COLUMNS = {
  commission: "commission_cents_corrected",
  received: "cash_cents_corrected",
} as const;

/**
 * One figure straight from the row, the commission or the cash received: click
 * it, type, Enter.
 *
 * Only that figure moves. `saveClosing` writes both at once, so using it here
 * would wipe the other one. A blank commission, or the desk's own figure, takes
 * the correction back off, so the row never says "was $150" next to $150. A
 * blank received clears it.
 */
export async function saveNightFigure(
  _prev: FigureState,
  formData: FormData,
): Promise<FigureState> {
  const { staff } = await getCurrentStaff();
  if (!staff || !staff.is_active || staff.role !== "owner") {
    return { error: "Only the owner can change a close." };
  }

  const field = String(formData.get("field") ?? "");
  if (field !== "commission" && field !== "received") {
    return { error: "Nothing to save." };
  }
  const column = FIGURE_COLUMNS[field];

  const closingId = String(formData.get("closing_id") ?? "");
  const kioskId = String(formData.get("kiosk_id") ?? "");
  const kioskSlug = String(formData.get("kiosk_slug") ?? "");
  const businessId = String(formData.get("business_id") ?? "");
  const businessDate = String(formData.get("business_date") ?? "");

  const amount = parseMoney(String(formData.get("amount") ?? ""));
  if (amount === "invalid") return { error: "Enter an amount of $0 or more." };

  const supabase = await getSupabaseServerClient();
  const stamp = {
    corrected_at: new Date().toISOString(),
    corrected_by: staff.id,
    // The numbers moved, so the night is no longer complete.
    reviewed_at: null,
    reviewed_by: null,
  };

  if (closingId) {
    let value = amount;
    if (field === "commission") {
      const { data: row, error: readError } = await supabase
        .from("kiosk_closings")
        .select("commission_cents")
        .eq("id", closingId)
        .single();
      if (readError) return { error: readError.message };
      if (amount === row.commission_cents) value = null;
    }
    const { error } = await supabase
      .from("kiosk_closings")
      .update({ [column]: value, ...stamp })
      .eq("id", closingId);
    if (error) return { error: error.message };
  } else {
    if (amount === null) return { saved: true };
    // Tonight's close belongs to the tablet. A row typed in now would stand in
    // for it before the desk has even counted.
    if (businessDate === nyDateISO()) {
      return { error: "Tonight is still open. Enter this after the close." };
    }
    if (!kioskId || !businessDate) {
      return { error: "This night has no kiosk on record, so it cannot be entered." };
    }
    const { error } = await supabase.from("kiosk_closings").insert({
      kiosk_id: kioskId,
      kiosk_slug: kioskSlug,
      business_id: businessId || null,
      business_date: businessDate,
      entered_manually: true,
      cash_cents: null,
      commission_cents: null,
      [column]: amount,
      ...stamp,
    });
    if (error) return { error: error.message };
  }

  revalidatePath("/admin/payments/cash");
  return { saved: true };
}
