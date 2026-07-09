"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import type { Database } from "@/lib/supabase/database.types";
import { getSupabaseServerClient } from "@/lib/supabase/server";

type BusinessUpdate = Database["public"]["Tables"]["businesses"]["Update"];

const ALLOWED_LOGO_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/svg+xml",
];
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

function fileExt(name: string, type: string): string {
  const fromName = name.includes(".") ? name.split(".").pop()! : "";
  if (fromName && fromName.length <= 5) return fromName.toLowerCase();
  if (type === "image/png") return "png";
  if (type === "image/jpeg" || type === "image/jpg") return "jpg";
  if (type === "image/webp") return "webp";
  if (type === "image/svg+xml") return "svg";
  return "bin";
}

/**
 * Extract the storage object path from a Supabase public URL of the form
 *   https://<ref>.supabase.co/storage/v1/object/public/<bucket>/<path>
 * Returns null if the URL is unparseable or points to a different bucket.
 */
function pathFromPublicUrl(url: string | null, bucket: string): string | null {
  if (!url) return null;
  const marker = `/storage/v1/object/public/${bucket}/`;
  const idx = url.indexOf(marker);
  if (idx < 0) return null;
  return url.slice(idx + marker.length);
}

export type UpdateBusinessState = {
  error?: string;
  fieldErrors?: Partial<
    Record<"name" | "phone" | "contact_email" | "logo", string>
  >;
  saved?: true;
};

export async function updateBusinessAction(
  id: string,
  _prev: UpdateBusinessState,
  formData: FormData,
): Promise<UpdateBusinessState> {
  const supabase = await getSupabaseServerClient();

  const name = String(formData.get("name") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim() || null;
  const contact_email =
    String(formData.get("contact_email") ?? "").trim() || null;
  const removeLogo = formData.get("remove_logo") === "1";
  const logoEntry = formData.get("logo");
  const logoFile =
    logoEntry instanceof File && logoEntry.size > 0 ? logoEntry : null;

  const fieldErrors: UpdateBusinessState["fieldErrors"] = {};
  if (!name) fieldErrors.name = "Name is required.";
  if (contact_email && !/^\S+@\S+\.\S+$/.test(contact_email)) {
    fieldErrors.contact_email = "Enter a valid email address.";
  }
  if (logoFile) {
    if (!ALLOWED_LOGO_TYPES.includes(logoFile.type)) {
      fieldErrors.logo = "Logo must be PNG, JPG, WebP, or SVG.";
    } else if (logoFile.size > MAX_LOGO_BYTES) {
      fieldErrors.logo = "Logo must be 2 MB or smaller.";
    }
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors };
  }

  // Read the current row so we know the old logo path for cleanup, and the
  // slug so we can name uploads consistently.
  const { data: current, error: readErr } = await supabase
    .from("businesses")
    .select("id, slug, logo_url")
    .eq("id", id)
    .maybeSingle();
  if (readErr) return { error: readErr.message };
  if (!current) return { error: "Business not found." };

  let logo_url: string | null | undefined = undefined; // undefined = keep
  if (logoFile) {
    const ext = fileExt(logoFile.name, logoFile.type);
    const path = `${current.slug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error: uploadErr } = await supabase.storage
      .from("business-logos")
      .upload(path, logoFile, { contentType: logoFile.type, upsert: false });
    if (uploadErr) {
      return { fieldErrors: { logo: `Could not upload logo: ${uploadErr.message}` } };
    }
    const { data: pub } = supabase.storage
      .from("business-logos")
      .getPublicUrl(path);
    logo_url = pub.publicUrl;
  } else if (removeLogo) {
    logo_url = null;
  }

  const patch: BusinessUpdate = { name, phone, contact_email };
  if (logo_url !== undefined) patch.logo_url = logo_url;

  const { error: updateErr } = await supabase
    .from("businesses")
    .update(patch)
    .eq("id", id);
  if (updateErr) return { error: updateErr.message };

  // Best-effort cleanup of the previous logo file when it's been replaced or
  // explicitly removed. We don't fail the action if cleanup errors.
  if (logo_url !== undefined && current.logo_url && current.logo_url !== logo_url) {
    const oldPath = pathFromPublicUrl(current.logo_url, "business-logos");
    if (oldPath) {
      await supabase.storage.from("business-logos").remove([oldPath]);
    }
  }

  revalidatePath("/admin/businesses");
  revalidatePath(`/admin/businesses/${id}`);
  revalidatePath("/admin");
  revalidatePath("/dashboard");
  return { saved: true };
}

export type DeleteBusinessState = {
  error?: string;
};

export async function deleteBusinessAction(
  id: string,
): Promise<DeleteBusinessState> {
  const supabase = await getSupabaseServerClient();

  const { data: current } = await supabase
    .from("businesses")
    .select("id, logo_url")
    .eq("id", id)
    .maybeSingle();

  const { error } = await supabase.from("businesses").delete().eq("id", id);
  if (error) {
    if (error.code === "23503") {
      return {
        error:
          "This business still has tours or other records attached. Delete those first, then try again.",
      };
    }
    return { error: error.message };
  }

  if (current?.logo_url) {
    const oldPath = pathFromPublicUrl(current.logo_url, "business-logos");
    if (oldPath) {
      await supabase.storage.from("business-logos").remove([oldPath]);
    }
  }

  revalidatePath("/admin/businesses");
  revalidatePath("/admin");
  revalidatePath("/dashboard");
  redirect("/admin/businesses");
}
