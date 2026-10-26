import { cn } from "@/lib/utils";

import { InfoTip } from "./info-tip";
import { Label } from "./label";

type FieldProps = {
  label: string;
  htmlFor?: string;
  /** Help that is not needed every time: shown on hover of an (i) beside the label. */
  hint?: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
};

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: FieldProps) {
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center gap-1.5">
        <Label htmlFor={htmlFor}>{label}</Label>
        {hint && <InfoTip text={hint} label={`About ${label}`} />}
      </div>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
