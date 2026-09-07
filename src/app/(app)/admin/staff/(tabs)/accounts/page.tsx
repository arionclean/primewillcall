import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SubmitButton } from "@/components/ui/submit-button";
import { getCurrentStaff } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { setAccountPinAction } from "../actions";

/**
 * Accounts: the shared desk logins (role check_in), one per desk or tablet. Not
 * people: a desk is signed in once and the people who work it type their PIN.
 * The one switch here decides whether that desk asks for a PIN, on its computer
 * and on its tablet alike. Owner only.
 */
export default async function AccountsPage() {
  const { staff: me } = await getCurrentStaff();
  if (me?.role !== "owner") redirect("/admin/staff");

  const supabase = await getSupabaseServerClient();
  const [accRes, kioskRes] = await Promise.all([
    supabase
      .from("staff")
      .select("id, full_name, email, is_active, kiosk_slug, pin_required, business:businesses!staff_business_id_fkey(name)")
      .eq("role", "check_in")
      .order("full_name"),
    supabase.from("kiosks").select("slug, name, pin_required"),
  ]);
  if (accRes.error) console.error("[accounts] fetch error:", accRes.error);
  const kioskBySlug = new Map((kioskRes.data ?? []).filter((k) => k.slug).map((k) => [k.slug as string, k]));
  const accounts = accRes.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          The logins for shared desks and tablets. A desk is signed in once; the people
          who work it type their own PIN, so every action is recorded under the person.
          Turn the PIN on for a desk when more than one person uses it.
        </p>
        <Link href="/admin/staff/new?role=check_in" className={buttonVariants({ variant: "default" })}>
          + Add account
        </Link>
      </div>

      {accRes.error && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Could not load the accounts. Refresh the page and try again.
        </p>
      )}

      {accounts.length === 0 ? (
        <p className="rounded-md border border-dashed bg-muted/30 px-3 py-3 text-sm text-muted-foreground">
          No shared accounts yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {accounts.map((a) => {
            const kiosk = a.kiosk_slug ? kioskBySlug.get(a.kiosk_slug) : undefined;
            const pinOn = a.pin_required || Boolean(kiosk?.pin_required);
            const details = [a.email, a.business?.name ?? null, kiosk ? `Tablet: ${kiosk.name}` : null].filter(Boolean);
            return (
              <li key={a.id}>
                <Card>
                  <CardContent className="flex flex-wrap items-center gap-3 py-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{a.full_name}</span>
                        <Badge tone={pinOn ? "success" : "neutral"}>{pinOn ? "Asks for a PIN" : "No PIN"}</Badge>
                        {!a.is_active && <Badge tone="neutral">Inactive</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground">{details.join(" · ")}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <form action={setAccountPinAction}>
                        <input type="hidden" name="staff_id" value={a.id} />
                        <input type="hidden" name="on" value={pinOn ? "0" : "1"} />
                        <SubmitButton variant="outline" size="sm">{pinOn ? "Turn PIN off" : "Turn PIN on"}</SubmitButton>
                      </form>
                      <Link href={`/admin/staff/${a.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                        Edit
                      </Link>
                    </div>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
