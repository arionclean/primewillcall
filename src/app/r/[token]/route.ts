import { NextResponse } from "next/server";

import { cancelPendingReviewSends } from "@/lib/reviews/funnel";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * PUBLIC tracked review link: /r/<token> -> the business's Google review page.
 *
 * Replaces Xano's bked.io/review/<shortID> hop. Its only job is to stamp
 * reviews.link_clicked_at before forwarding, which is what tells the reminder
 * sweep NOT to nudge someone who already went and left the review.
 *
 * No auth (it is handed to customers over SMS), so it lives outside the (app)
 * group and reads with the service role by exact token, the same shape as
 * /booking/<token>.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const home = new URL("/", process.env.NEXT_PUBLIC_APP_URL ?? "https://primewillcall.com");

  const db = getSupabaseAdminClient();
  if (!db || !token) {
    return NextResponse.redirect(home);
  }

  const { data: review } = await db
    .from("reviews")
    .select("id, booking_id, link_clicked_at, business:businesses(google_review_url)")
    .eq("token", token)
    .maybeSingle();

  if (!review) {
    return NextResponse.redirect(home);
  }

  // First click wins, so the timestamp reflects when they actually went.
  // Clicking also stops anything still queued for them, which is Xano's
  // stopTask: someone who has gone to leave the review must not be nudged.
  if (!review.link_clicked_at) {
    const now = new Date().toISOString();
    await db
      .from("reviews")
      .update({ link_clicked_at: now, cancelled_at: now, cancel_reason: "clicked_link" })
      .eq("id", review.id);
    await cancelPendingReviewSends(db, { bookingId: review.booking_id ?? undefined });
  }

  const business = review.business as { google_review_url: string | null } | null;
  const target = (business?.google_review_url ?? "").trim();
  if (!target) {
    return NextResponse.redirect(home);
  }

  return NextResponse.redirect(target);
}
