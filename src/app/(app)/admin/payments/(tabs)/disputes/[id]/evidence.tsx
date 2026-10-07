"use client";

import { Eye, FileText, X } from "lucide-react";
import { useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import {
  EVIDENCE_FIELDS,
  fileSize,
  invokeStripeDisputes,
  type DisputeDetail,
  type EvidenceFile,
} from "@/lib/payments/disputes";

/** Stripe names a file's type by extension; a Blob needs the MIME type to open. */
function mimeOf(type: string | null): string {
  switch (type) {
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}

/**
 * Open an evidence file in a new tab. The tab is opened on the click itself (a
 * tab opened after an await is blocked as a pop-up), then pointed at the file
 * once its bytes arrive. Returns an error message, or null.
 */
export async function openEvidenceFile(disputeId: string, file: EvidenceFile): Promise<string | null> {
  const tab = window.open("", "_blank");
  const { data, error } = await invokeStripeDisputes<Blob>({
    action: "file",
    dispute_id: disputeId,
    file_id: file.id,
  });
  if (error || !(data instanceof Blob)) {
    tab?.close();
    return error ?? "Stripe did not send the file.";
  }
  const url = URL.createObjectURL(new Blob([data], { type: mimeOf(file.type) }));
  if (tab) tab.location.href = url;
  else window.location.assign(url);
  // The tab has loaded it by then; free the memory.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return null;
}

/** One attached file: name, size, open, and (in the form) remove. */
export function FileChip({
  disputeId,
  file,
  onRemove,
  disabled,
}: {
  disputeId: string;
  file: EvidenceFile;
  onRemove?: () => void;
  disabled?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
        <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{file.filename}</span>
        {file.size > 0 && <span className="shrink-0 text-xs text-muted-foreground">{fileSize(file.size)}</span>}
        <button
          type="button"
          onClick={async () => setError(await openEvidenceFile(disputeId, file))}
          className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Eye className="size-3.5" aria-hidden />
          View
        </button>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled}
            aria-label={`Remove ${file.filename}`}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <X className="size-4" aria-hidden />
          </button>
        )}
      </div>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** The evidence on a dispute that can no longer be changed: what the bank has. */
export function EvidenceSummary({ detail }: { detail: DisputeDetail }) {
  const { dispute, evidence } = detail;
  const filled = EVIDENCE_FIELDS.filter((f) =>
    f.kind === "text" ? evidence.text[f.key]?.trim() : evidence.files[f.key],
  );
  const sent = dispute.submissionCount > 0;

  return (
    <section className="space-y-3">
      <div className="px-1">
        <h2 className="text-lg font-semibold tracking-tight">
          {sent ? "What was sent to the bank" : "Evidence"}
        </h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {sent
            ? "This is the answer the bank is judging. It cannot be changed."
            : filled.length > 0
              ? "This evidence was saved but never sent to the bank."
              : "No evidence was sent for this dispute."}
        </p>
      </div>
      {filled.length > 0 && (
        <Card>
          <CardContent className="divide-y py-2">
            {filled.map((f) => (
              <div key={f.key} className="space-y-1.5 py-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{f.label}</p>
                {f.kind === "text" ? (
                  <p className="whitespace-pre-wrap text-sm">{evidence.text[f.key]}</p>
                ) : (
                  <FileChip disputeId={dispute.id} file={evidence.files[f.key]!} />
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </section>
  );
}
