import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import { personValue, type PersonOption } from "./activity-shared";
import type { EmployeeRow } from "./people-view";

/** The people who type a PIN (kiosk_employees), one pool for every business. */
export async function loadEmployees(
  supabase: SupabaseClient<Database>,
): Promise<{ employees: EmployeeRow[]; error: boolean }> {
  const { data, error } = await supabase
    .from("kiosk_employees")
    .select("id, name, is_active, last_seen_at, last_seen_kiosk")
    .order("name");
  if (error) console.error("[people] employees fetch error:", error);
  return {
    employees: (data ?? []).map((e) => ({
      id: e.id,
      name: e.name,
      isActive: e.is_active,
      lastSeenAt: e.last_seen_at,
      lastSeenKiosk: e.last_seen_kiosk,
    })),
    error: Boolean(error),
  };
}

/**
 * Who the Activity filter can pick: the people (by PIN) and the logins (by
 * account), each under its own heading. Reads run as the caller, so a manager
 * sees the logins their RLS allows.
 */
export async function loadPersonOptions(
  supabase: SupabaseClient<Database>,
): Promise<{ people: PersonOption[]; accounts: PersonOption[] }> {
  const [empRes, staffRes] = await Promise.all([
    supabase.from("kiosk_employees").select("id, name").order("name"),
    supabase.from("staff").select("id, full_name").order("full_name"),
  ]);
  if (empRes.error) console.error("[activity] employees fetch error:", empRes.error);
  if (staffRes.error) console.error("[activity] staff fetch error:", staffRes.error);
  return {
    people: (empRes.data ?? []).map((e) => ({ value: personValue(e.id, null), name: e.name })),
    accounts: (staffRes.data ?? []).map((s) => ({ value: personValue(null, s.id), name: s.full_name })),
  };
}
