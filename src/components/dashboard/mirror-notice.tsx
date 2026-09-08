import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Failure = {
  id: number;
  guest: string;
  date: string;
  reason: string;
};

type MirrorNoticeProps = {
  /** Changes queued and not yet copied to the old system. */
  waitingCount: number;
  /** Changes the copy gave up on. */
  failedCount: number;
  /** The most recent failures, newest first (at most a handful). */
  failures: Failure[];
};

/**
 * The owner's view of the copy into the old system (docs/xano-mirror.md): how much
 * is still on its way, and what could not be copied and why. Rendered only when
 * there is something to say.
 */
export function MirrorNotice({
  waitingCount,
  failedCount,
  failures,
}: MirrorNoticeProps) {
  const waitingLine =
    waitingCount > 0
      ? `${waitingCount} booking ${waitingCount === 1 ? "change is" : "changes are"} still being copied to the old system. That usually takes under a minute.`
      : null;
  const failedLine =
    failedCount > 0
      ? `${failedCount} ${failedCount === 1 ? "change" : "changes"} could not be copied. The old system will not show ${failedCount === 1 ? "it" : "them"} until the reason below is fixed.`
      : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Copy to the old system</CardTitle>
        <CardDescription>
          {[waitingLine, failedLine].filter(Boolean).join(" ")}
        </CardDescription>
      </CardHeader>
      {failures.length > 0 && (
        <CardContent className="pt-0">
          <ul className="space-y-1 text-sm">
            {failures.map((f) => (
              <li key={f.id} className="flex flex-wrap gap-x-2">
                <span className="font-medium">
                  {f.guest}
                  {f.date ? `, ${f.date}` : ""}
                </span>
                <span className="text-muted-foreground">{f.reason}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}
