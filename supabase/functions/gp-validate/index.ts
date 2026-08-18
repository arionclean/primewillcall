// Public voucher validator for the /gp page. Supabase-native replacement for the Vercel
// route src/app/api/gp/validate/route.ts.
//
// Uploads the voucher photo to the gp-vouchers bucket with the service role, then hands
// the public URL to the gp-voucher-vision function (Google OCR -> Groq fallback ->
// deterministic alias match -> Groq extraction; the AI keys are that function's secrets).
// Returns the resolved product plus the Supabase-managed fee. It never creates a booking.
//
// Deployed with JWT on: the public page sends the publishable anon key.
// Body: multipart/form-data with `file`.

import { corsHeaders, db, json, SERVICE_KEY, SUPABASE_URL } from "../_shared/gp.ts";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);
const VISION_TIMEOUT_MS = 30_000;

interface GrouponMatch {
  business_tour_id: string;
  business_id: string;
  business_name: string;
  product_name: string;
  groupon_fee_cents: number;
}

interface VisionResult {
  ok?: boolean;
  valid?: boolean;
  matched?: GrouponMatch | null;
  passengers?: unknown;
  voucher_code?: unknown;
  reason?: unknown;
}

/**
 * Call the vision function with the service role as the bearer (it compares against its
 * own copy, so there is no extra shared secret). Null means unreachable or unconfigured,
 * which the caller degrades on rather than failing hard.
 */
async function classifyVoucherImage(imageUrl: string): Promise<VisionResult | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/gp-voucher-vision`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ image_url: imageUrl }),
      signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const j = await res.json() as VisionResult;
    return j.ok === true ? j : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ valid: false, error: "POST only" }, 405);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ valid: false, error: "bad_request" }, 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return json({ valid: false, error: "missing_file" }, 400);
  }
  if (file.size === 0 || file.size > MAX_BYTES) {
    return json({ valid: false, error: "bad_file", message: "Image must be under 10 MB." }, 400);
  }
  const type = ALLOWED.has(file.type) ? file.type : "image/jpeg";

  // 1. Store the voucher image (service role bypasses storage RLS). The vision
  //    function reads it back from this public URL.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
  const path = `${crypto.randomUUID()}.${ext}`;
  const { error: upErr } = await db.storage
    .from("gp-vouchers")
    .upload(path, bytes, { contentType: type, upsert: false });
  if (upErr) {
    console.error("[gp-validate] upload failed:", upErr.message);
    return json(
      { valid: false, error: "server_error", message: "Could not store the image. Please try again." },
      500,
    );
  }
  const imageUrl = db.storage.from("gp-vouchers").getPublicUrl(path).data.publicUrl;

  // 2. OCR + match + extraction.
  const result = await classifyVoucherImage(imageUrl);
  if (!result) {
    return json(
      {
        valid: false,
        error: "vision_unavailable",
        message: "We could not read that image. Please try a clearer photo.",
        imageUrl,
      },
      200,
    );
  }

  if (!result.valid || !result.matched) {
    const reason = typeof result.reason === "string" ? result.reason : "";
    return json(
      {
        valid: false,
        reason: reason || "That photo does not match a supported Groupon voucher.",
        imageUrl,
      },
      200,
    );
  }

  const match = result.matched;
  const passengersRaw = Number(result.passengers);
  const voucherCode = typeof result.voucher_code === "string" && result.voucher_code.trim()
    ? result.voucher_code.trim()
    : null;

  return json({
    valid: true,
    businessTourId: match.business_tour_id,
    businessId: match.business_id,
    businessName: match.business_name,
    productName: match.product_name,
    feeCents: match.groupon_fee_cents,
    passengers: Number.isFinite(passengersRaw) && passengersRaw > 0 ? Math.floor(passengersRaw) : 1,
    voucherCode,
    imageUrl,
  });
});
