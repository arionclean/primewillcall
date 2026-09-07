import { redirect } from "next/navigation";

import { getCurrentStaff } from "@/lib/auth";

/** Adding and editing team members is the owner's. Managers go to their Employees tab. */
export default async function OwnerOnlyStaffLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { staff } = await getCurrentStaff();
  if (staff?.role !== "owner") redirect("/admin/staff/people");
  return <>{children}</>;
}
