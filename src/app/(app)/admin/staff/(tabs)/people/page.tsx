import { getCurrentStaff, staffCapabilities } from "@/lib/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import { loadEmployees } from "../people";
import { PeopleView } from "../people-view";

/**
 * People: the employees who type a PIN on the tablets and shared computers, one
 * pool for every business. Logins are the Accounts tab; what everyone did is
 * the Activity tab.
 */
export default async function PeoplePage() {
  const { staff } = await getCurrentStaff();
  const supabase = await getSupabaseServerClient();
  const { employees, error } = await loadEmployees(supabase);
  const canManage = staff ? staffCapabilities(staff).canManageTeam : false;
  return <PeopleView employees={employees} canManage={canManage} loadError={error} />;
}
