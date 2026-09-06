"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";

/**
 * Keep the signed-in staffer's access token in step with their staff row.
 *
 * The app reads who someone is, and what they may do, from the `app_staff`
 * claim the custom access token hook writes into the JWT (see
 * `getCurrentStaff` in lib/auth.ts). A token lives about an hour, so on its
 * own a permission the owner just switched off would keep showing on that
 * person's screen until the next reissue. The database refuses the click in
 * the meantime, but a button that is there and does not work is a bug.
 *
 * So this watches the staffer's own `staff` row over Realtime (the
 * `staff_select` policy lets every account read its own row) and, when it
 * changes, asks Auth for a new token. Refreshing reruns the hook, the new
 * claims land in the auth cookie, and `router.refresh()` re-renders the
 * server tree from them: sidebar, page and buttons at once.
 *
 * A change can also land while nobody is listening (a laptop asleep, a tab
 * opened later in the same hour). Each time the subscription joins, first
 * time or after a reconnect, it compares the row's `updated_at` with the
 * token's issued-at and refreshes if the row is newer. One primary-key read,
 * after paint, never on the render path.
 *
 * Mounted once by the `(app)` layout, so it lives across client navigations.
 */
export function StaffClaimsSync({ staffId }: { staffId: string }) {
  const router = useRouter();

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    let disposed = false;

    const refresh = async () => {
      const { error } = await supabase.auth.refreshSession();
      if (disposed) return;
      if (error) {
        // Nothing to show staff. The token still expires on schedule, and the
        // database enforces the new permissions regardless.
        console.error("[auth] session refresh after a staff change failed", error);
        return;
      }
      router.refresh();
    };

    const verify = async () => {
      const issuedAt = await tokenIssuedAt(supabase);
      if (issuedAt === null) return;
      const { data } = await supabase
        .from("staff")
        .select("updated_at")
        .eq("id", staffId)
        .maybeSingle();
      if (disposed || !data) return;
      if (new Date(data.updated_at).getTime() > issuedAt) void refresh();
    };

    const channel = supabase
      .channel(`staff:${staffId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "staff",
          filter: `id=eq.${staffId}`,
        },
        () => void refresh(),
      )
      .subscribe((status, err) => {
        if (status === "SUBSCRIBED") void verify();
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.error(`[realtime] staff:${staffId} ${status}`, err ?? "");
        }
      });

    return () => {
      disposed = true;
      void supabase.removeChannel(channel);
    };
  }, [staffId, router]);

  return null;
}

/**
 * When the current access token was issued, in ms since the epoch, or null
 * without a session. Read straight off the token we already hold: this is a
 * hint for the UI, and the server verifies the signature on every request.
 */
async function tokenIssuedAt(
  supabase: ReturnType<typeof getSupabaseBrowserClient>,
): Promise<number | null> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return null;
  try {
    const payload = token.split(".")[1] ?? "";
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const iat = (JSON.parse(json) as { iat?: unknown }).iat;
    return typeof iat === "number" ? iat * 1000 : null;
  } catch {
    return null;
  }
}
