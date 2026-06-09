"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getSupabaseServerClient } from "@/lib/supabase/server";

const ALLOWED_LOGO_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/svg+xml",
];
const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2 MB

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function fileExt(name: string, type: string): string {
  const fromName = name.includes(".") ? name.split(".").pop()! : "";
  if (fromName && fromName.length <= 5) return fromName.toLowerCase();
  if (type === "image/png") return "png";
  if (type === "image/jpeg" || type === "image/jpg") return "jpg";
  if (type === "image/webp") return "webp";
  if (type === "image/svg+xml") return "svg";
  return "bin";
}

export type CreateBusinessState = {
  error?: string;
  fieldErrors?: Partial<Record<"name" | "phone" | "logo", string>>;
};

export async function createBusinessAction(
  _prev: CreateBusinessState,
  formData: FormData,
): Promise<CreateBusinessState> {
  const supabase = await getSupabaseServerClient();

  const name = String(formData.get("name") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim() || null;
  const logoEntry = formData.get("logo");
  const logoFile =
    logoEntry instanceof File && logoEntry.size > 0 ? logoEntry : null;

  const fieldErrors: CreateBusinessState["fieldErrors"] = {};
  if (!name) fieldErrors.name = "Name is required.";

  if (logoFile) {
    if (!ALLOWED_LOGO_TYPES.includes(logoFile.type)) {
      fieldErrors.logo = "Logo must be PNG, JPG, WebP, or SVG.";
    } else if (logoFile.size > MAX_LOGO_BYTES) {
      fieldErrors.logo = "Logo must be 2 MB or smaller.";
    }
  }

  const slug = slugify(name);
  if (!slug && name) {
    fieldErrors.name = "Use a name with at least one letter or number.";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors };
  }

  // Upload logo first so we can store the URL with the row. If upload fails,
  // the business is NOT created so the user can retry from a clean state.
  let logo_url: string | null = null;
  if (logoFile) {
    const ext = fileExt(logoFile.name, logoFile.type);
    const path = `${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error: uploadErr } = await supabase.storage
      .from("business-logos")
      .upload(path, logoFile, { contentType: logoFile.type, upsert: false });
    if (uploadErr) {
      return {
        fieldErrors: { logo: `Could not upload logo: ${uploadErr.message}` },
      };
    }
    const { data: pub } = supabase.storage
      .from("business-logos")
      .getPublicUrl(path);
    logo_url = pub.publicUrl;
  }

  const { error } = await supabase.from("businesses").insert({
    name,
    slug,
    phone,
    logo_url,
    timezone: "America/New_York",
  });

  if (error) {
    if (error.code === "23505") {
      // Unique slug collision — retry once with a numeric suffix.
      const altSlug = `${slug}-${Math.floor(Math.random() * 1000)}`;
      const { error: retryErr } = await supabase.from("businesses").insert({
        name,
        slug: altSlug,
        phone,
        logo_url,
        timezone: "America/New_York",
      });
      if (retryErr) {
        return { error: retryErr.message };
      }
    } else {
      return { error: error.message };
    }
  }

  revalidatePath("/admin/businesses");
  revalidatePath("/admin");
  revalidatePath("/dashboard");
  redirect("/admin/businesses");
}
