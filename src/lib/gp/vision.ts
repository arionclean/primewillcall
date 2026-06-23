// Client for the gp-voucher-vision Supabase edge function (server-only).
//
// The vision chain itself (Google OCR -> Groq fallback -> deterministic alias
// match -> Groq extraction) lives in supabase/functions/gp-voucher-vision, where
// the AI keys are Supabase function secrets. This module is the typed caller the
// /api/gp/validate route uses. Auth is the service role key as the bearer; the
// function compares it against its own copy, so no extra shared secret exists.

const REQUEST_TIMEOUT_MS = 30_000;

export type GrouponMatch = {
  business_tour_id: string;
  business_id: string;
  business_name: string;
  tour_id: string;
  tour_name: string;
  product_name: string;
  groupon_fee_cents: number;
  aliases: string[];
};

export type VoucherVisionResult = {
  ok: boolean;
  valid: boolean;
  matched: GrouponMatch | null;
  passengers: number;
  voucher_code: string | null;
  reason: string;
  ocr: "google" | "groq" | null;
  match_method: "alias" | "ai" | null;
};

/**
 * Sends the (already uploaded) gp-vouchers public URL to the vision edge
 * function. Returns null when the function is unreachable or unconfigured so the
 * caller can degrade gracefully.
 */
export async function classifyVoucherImage(
  imageUrl: string,
): Promise<VoucherVisionResult | null> {
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceKey) return null;

  try {
    const res = await fetch(`${baseUrl}/functions/v1/gp-voucher-vision`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ image_url: imageUrl }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as Partial<VoucherVisionResult>;
    if (j.ok !== true) return null;
    return {
      ok: true,
      valid: j.valid === true,
      matched: j.matched ?? null,
      passengers:
        Number.isFinite(Number(j.passengers)) && Number(j.passengers) > 0
          ? Math.floor(Number(j.passengers))
          : 1,
      voucher_code:
        typeof j.voucher_code === "string" && j.voucher_code.trim()
          ? j.voucher_code.trim()
          : null,
      reason: typeof j.reason === "string" ? j.reason : "",
      ocr: j.ocr === "google" || j.ocr === "groq" ? j.ocr : null,
      match_method:
        j.match_method === "alias" || j.match_method === "ai"
          ? j.match_method
          : null,
    };
  } catch {
    return null;
  }
}
