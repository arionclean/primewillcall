import { cn } from "@/lib/utils";

import { Card, CardContent } from "./card";
import { InfoTip } from "./info-tip";

type FormSectionProps = {
  title: string;
  /** What the section is for: shown on hover of an (i) beside the title. */
  description?: string;
  /** Extra classes to apply to the inner CardContent (e.g. grid layout). */
  contentClassName?: string;
  children: React.ReactNode;
};

/**
 * Page-level form section: a bold title sits OUTSIDE the card so it reads as a
 * section header, not a field label. Use one per logical group on a form page.
 */
export function FormSection({
  title,
  description,
  contentClassName,
  children,
}: FormSectionProps) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-1.5 px-1">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {description && <InfoTip text={description} label={`About ${title}`} />}
      </div>
      <Card>
        <CardContent className={cn("py-6", contentClassName)}>
          {children}
        </CardContent>
      </Card>
    </section>
  );
}
