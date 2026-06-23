import { NextResponse } from "next/server";

import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { classifyVoucherImage } from "@/lib/gp/vision";

/**
 * Public voucher validator for the /gp page (no auth). Runs server-side with the
 * service role: uploads the voucher photo to the gp-vouchers bucket, then hands
 * the public URL to the gp-voucher-vision edge function (Google OCR -> Groq
 * fallback -> deterministic alias match -> Groq extraction; AI keys live as
 * Supabase function secrets). Returns the resolved product + the Supabase-managed
 * fee. It never creates a booking.
 */

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

export async function POST(req: Request) {
  const admin = getSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json(
      { valid: false, error: "not_configured", message: "Voucher upload is not configured." },
      { status: 503 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ valid: false, error: "bad_request" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ valid: false, error: "missing_file" }, { status: 400 });
  }
  if (file.size === 0 || file.size > MAX_BYTES) {
    return NextResponse.json(
      { valid: false, error: "bad_file", message: "Image must be under 10 MB." },
      { status: 400 },
    );
  }
  const type = ALLOWED.has(file.type) ? file.type : "image/jpeg";

  // 1. Store the voucher image (service role bypasses storage RLS). The vision
  //    edge function reads it back from this public URL.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
  const path = `${crypto.randomUUID()}.${ext}`;
  const { error: upErr } = await admin.storage
    .from("gp-vouchers")
    .upload(path, bytes, { contentType: type, upsert: false });
  if (upErr) {
    return NextResponse.json(
      { valid: false, error: "server_error", message: "Could not store the image. Please try again." },
      { status: 500 },
    );
  }
  const imageUrl = admin.storage.from("gp-vouchers").getPublicUrl(path).data.publicUrl;

  // 2. OCR + match + extraction in the edge function.
  const result = await classifyVoucherImage(imageUrl);
  if (!result) {
    return NextResponse.json(
      {
        valid: false,
        error: "vision_unavailable",
        message: "We could not read that image. Please try a clearer photo.",
        imageUrl,
      },
      { status: 200 },
    );
  }

  if (!result.valid || !result.matched) {
    return NextResponse.json(
      {
        valid: false,
        reason: result.reason || "That photo does not match a supported Groupon voucher.",
        imageUrl,
      },
      { status: 200 },
    );
  }

  const match = result.matched;
  return NextResponse.json({
    valid: true,
    businessTourId: match.business_tour_id,
    businessId: match.business_id,
    businessName: match.business_name,
    productName: match.product_name,
    feeCents: match.groupon_fee_cents,
    passengers: result.passengers,
    voucherCode: result.voucher_code,
    imageUrl,
  });
}
