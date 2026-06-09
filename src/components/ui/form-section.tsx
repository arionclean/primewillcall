import { cn } from "@/lib/utils";

import { Card, CardContent } from "./card";

type FormSectionProps = {
  title: string;
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
      <div className="px-1">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {description && (
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      <Card>
        <CardContent className={cn("py-6", contentClassName)}>
          {children}
        </CardContent>
      </Card>
    </section>
  );
}
