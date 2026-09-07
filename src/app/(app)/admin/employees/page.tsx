import { redirect } from "next/navigation";

/** The Employees page moved under Team; old links and bookmarks still land. */
export default function EmployeesMoved() {
  redirect("/admin/staff/employees");
}
