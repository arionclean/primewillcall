import { redirect } from "next/navigation";

/** Employees became People, the first tab of Team. Old links still land, filters included. */
export default async function EmployeesMoved({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const qs = new URLSearchParams(
    Object.entries(sp).filter((e): e is [string, string] => typeof e[1] === "string"),
  ).toString();
  redirect(qs ? `/admin/staff?${qs}` : "/admin/staff");
}
