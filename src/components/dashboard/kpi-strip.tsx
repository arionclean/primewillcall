import { Card } from "@/components/ui/card";
import type { DashboardKpis } from "@/lib/dashboard/queries";

type KpiStripProps = {
  kpis: DashboardKpis;
};

const tiles = [
  { key: "guests", label: "Guests today" },
  { key: "checkedGuests", label: "Checked in" },
  { key: "notCheckedGuests", label: "Not checked in" },
] as const;

export function KpiStrip({ kpis }: KpiStripProps) {
  const values: Record<(typeof tiles)[number]["key"], string> = {
    guests: String(kpis.guests),
    checkedGuests: String(kpis.checkedGuests),
    notCheckedGuests: String(kpis.notCheckedGuests),
  };

  return (
    <div className="grid grid-cols-3 gap-3">
      {tiles.map((t) => (
        <Card key={t.key} className="p-4">
          <p className="text-xs font-medium text-muted-foreground">{t.label}</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight">
            {values[t.key]}
          </p>
        </Card>
      ))}
    </div>
  );
}
