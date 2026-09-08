"use server";

import { revalidatePath } from "next/cache";

import { getCurrentStaff } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Booking sources: the list the Schedule form offers for where a desk booking
 * came from (`booking_source_options`). The owner adds, hides, reorders and
 * removes them here. The name is stored verbatim on every booking that picks it
 * (`bookings.source_channel`), so there is no rename: a source that should read
 * differently is hidden and a new one added, and the bookings keep their history.
 * Owner-only, re-checked here and enforced by RLS.
 */

export type SourceActionState = {
  error?: string;
  fieldErrors?: { name?: string };
  saved?: true;
};

const PATH = "/admin/businesses/sources";
const MAX_LENGTH = 60;

async function requireOwner(): Promise<string | null> {
  const { user, staff } = await getCurrentStaff();
  if (!user || !staff || !staff.is_active) return "Not signed in.";
  if (staff.role !== "owner") return "Only the owner can change booking sources.";
  return null;
}

function revalidate() {
  revalidatePath(PATH);
  revalidatePath("/schedule");
}

/** One clean name: trimmed, inner runs of spaces collapsed. */
function cleanName(raw: FormDataEntryValue | null): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim();
}

export async function addSource(
  _prev: SourceActionState,
  formData: FormData,
): Promise<SourceActionState> {
  const denied = await requireOwner();
  if (denied) return { error: denied };

  const name = cleanName(formData.get("name"));
  if (!name) return { fieldErrors: { name: "Type a name." } };
  if (name.length > MAX_LENGTH) {
    return { fieldErrors: { name: `Keep it under ${MAX_LENGTH} characters.` } };
  }

  const supabase = await getSupabaseServerClient();

  // The same name in another spelling of case is the same source to a person.
  // A hidden twin comes back instead of being duplicated.
  const { data: rows, error: readError } = await supabase
    .from("booking_source_options")
    .select("channel, is_active, sort_order")
    .order("sort_order", { ascending: true });
  if (readError) {
    console.error("[sources] read:", readError);
    return { error: "Could not read the list. Try again." };
  }
  const twin = (rows ?? []).find((r) => r.channel.toLowerCase() === name.toLowerCase());
  if (twin) {
    if (twin.is_active) return { fieldErrors: { name: "Already in the list." } };
    const { error } = await supabase
      .from("booking_source_options")
      .update({ is_active: true, updated_at: new Date().toISOString() })
      .eq("channel", twin.channel);
    if (error) {
      console.error("[sources] reactivate:", error);
      return { error: "Could not add the source. Try again." };
    }
    revalidate();
    return { saved: true };
  }

  const last = (rows ?? []).reduce((m, r) => Math.max(m, r.sort_order), 0);
  const { error } = await supabase
    .from("booking_source_options")
    .insert({ channel: name, sort_order: last + 10 });
  if (error) {
    console.error("[sources] insert:", error);
    return { error: "Could not add the source. Try again." };
  }
  revalidate();
  return { saved: true };
}

export async function setSourceShown(
  channel: string,
  shown: boolean,
): Promise<{ error?: string }> {
  const denied = await requireOwner();
  if (denied) return { error: denied };
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase
    .from("booking_source_options")
    .update({ is_active: shown, updated_at: new Date().toISOString() })
    .eq("channel", channel);
  if (error) {
    console.error("[sources] shown:", error);
    return { error: "Could not save. Try again." };
  }
  revalidate();
  return {};
}

/** The whole order at once, top to bottom, so two quick moves cannot cross. */
export async function reorderSources(order: string[]): Promise<{ error?: string }> {
  const denied = await requireOwner();
  if (denied) return { error: denied };
  const supabase = await getSupabaseServerClient();
  const stamp = new Date().toISOString();
  for (const [index, channel] of order.entries()) {
    const { error } = await supabase
      .from("booking_source_options")
      .update({ sort_order: (index + 1) * 10, updated_at: stamp })
      .eq("channel", channel);
    if (error) {
      console.error("[sources] reorder:", error);
      return { error: "Could not save the order. Try again." };
    }
  }
  revalidate();
  return {};
}

export async function removeSource(channel: string): Promise<{ error?: string }> {
  const denied = await requireOwner();
  if (denied) return { error: denied };
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase
    .from("booking_source_options")
    .delete()
    .eq("channel", channel);
  if (error) {
    console.error("[sources] remove:", error);
    return { error: "Could not remove the source. Try again." };
  }
  revalidate();
  return {};
}
