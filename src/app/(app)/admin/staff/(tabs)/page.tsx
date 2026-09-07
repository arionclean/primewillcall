import { redirect } from "next/navigation";

import { getCurrentStaff } from "@/lib/auth";

/** Team opens on Accounts for the owner; a manager has no Accounts tab and opens on People. */
export default async function TeamIndex() {
  const { staff } = await getCurrentStaff();
  redirect(staff?.role === "owner" ? "/admin/staff/accounts" : "/admin/staff/people");
}
