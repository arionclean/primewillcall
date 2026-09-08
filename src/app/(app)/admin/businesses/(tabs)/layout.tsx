import { PageTabs, type PageTab } from "@/components/app/page-tabs";

/**
 * The Businesses screen: one title, two tabs. "Businesses" is the list of
 * businesses; "Booking sources" is the list the Schedule form offers for where a
 * desk booking came from. The owner-only gate is the parent layout; the detail
 * pages (/new, /[id]) sit outside this group so they carry no tabs.
 */
export default function BusinessesTabsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const tabs: PageTab[] = [
    { href: "/admin/businesses", label: "Businesses" },
    { href: "/admin/businesses/sources", label: "Booking sources" },
  ];

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Businesses</h1>
      <PageTabs tabs={tabs} label="Businesses views" />
      {children}
    </div>
  );
}
