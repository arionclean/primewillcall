// Explicit activity rows from edge functions that write with the service role.
//
// The log_staff_change trigger only sees a person's own session (auth.uid()), so a
// function that writes as the system on a staff member's behalf (payments: refunds,
// moving a sale) records the action itself, naming the staff account it verified
// and the employee the browser sent along in the x-employee-id header.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EmployeeRef {
  id: string;
  name: string;
}

/** The employee behind a shared login, from the request header; null when none or unknown. */
export async function employeeFromRequest(
  db: SupabaseClient,
  req: Request,
): Promise<EmployeeRef | null> {
  const id = (req.headers.get("x-employee-id") ?? "").trim();
  if (!UUID_RE.test(id)) return null;
  const { data } = await db
    .from("kiosk_employees")
    .select("id, name, is_active")
    .eq("id", id)
    .maybeSingle<{ id: string; name: string; is_active: boolean }>();
  return data && data.is_active ? { id: data.id, name: data.name } : null;
}

export async function logStaffAction(
  db: SupabaseClient,
  input: {
    staffId: string;
    businessId: string | null;
    employee: EmployeeRef | null;
    entity: string;
    entityId: string | null;
    action: string;
    payload?: Record<string, unknown>;
    changed?: string[];
  },
): Promise<void> {
  const { error } = await db.from("audit_log").insert({
    actor_staff_id: input.staffId,
    business_id: input.businessId,
    employee_id: input.employee?.id ?? null,
    employee_name: input.employee?.name ?? null,
    entity: input.entity,
    entity_id: input.entityId,
    action: input.action,
    changed: input.changed ?? [],
    payload: input.payload ?? {},
    source: "web",
  });
  // The action already happened; a lost log line is worth a console line, not a failure.
  if (error) console.error("[audit] could not record", input.entity, input.action, error);
}
