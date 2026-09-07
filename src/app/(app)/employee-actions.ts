"use server";

import { getCurrentStaff } from "@/lib/auth";
import { clearWebEmployeeCookies, getWebEmployee, setWebEmployeeCookies } from "@/lib/employee-session";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export type UnlockState = { error?: string; unlocked?: true };

/**
 * The keypad on a shared login. The PIN goes to `web_employee_unlock`, which
 * checks it against the employee pool, records the attempt in the activity log
 * and hands back who it is; that person is then kept in the employee cookies
 * until they tap Lock. The page reloads afterwards so the browser client picks
 * up the employee header for its own writes.
 */
export async function unlockWebEmployeeAction(
  _prev: UnlockState,
  formData: FormData,
): Promise<UnlockState> {
  const { staff } = await getCurrentStaff();
  if (!staff || !staff.is_active) return { error: "Not signed in." };
  if (!staff.pin_required) return { unlocked: true };

  const pin = String(formData.get("pin") ?? "").trim();
  if (!/^\d{4}$/.test(pin)) return { error: "Wrong PIN" };

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("web_employee_unlock", { p_pin: pin });
  if (error) {
    console.error("[employee] unlock:", error);
    return { error: "Could not check the PIN. Try again." };
  }
  const match = data?.[0];
  if (!match?.id) return { error: "Wrong PIN" };

  await setWebEmployeeCookies({ id: match.id, name: match.name ?? "" });
  return { unlocked: true };
}

/** The person tapped Lock: record it and forget who was at the keyboard. */
export async function lockWebEmployeeAction(): Promise<void> {
  const employee = await getWebEmployee();
  if (employee) {
    const supabase = await getSupabaseServerClient();
    const { error } = await supabase.rpc("web_employee_lock", { p_employee: employee.id });
    if (error) console.error("[employee] lock:", error);
  }
  await clearWebEmployeeCookies();
}
