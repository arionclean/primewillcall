"use client";

import { ChevronDown, ChevronRight, LoaderCircle, Plus, Upload } from "lucide-react";
import { useEffect, useId, useMemo, useState, type CSSProperties } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { Textarea } from "@/components/ui/textarea";
import {
  EVIDENCE_FIELDS,
  FILE_ACCEPT,
  FILE_FIELD_KEYS,
  MAX_FILES_BYTES,
  MAX_TEXT_FIELD,
  TEXT_FIELD_KEYS,
  fileSize,
  invokeStripeDisputes,
  recommendedFields,
  type DisputeDetail,
  type EvidenceFile,
  type FieldSpec,
  type FileField,
  type TextField,
} from "@/lib/payments/disputes";
import { invokeEdgeFunction } from "@/lib/payments/edge";
import { money } from "@/lib/payments/format";
import { cn } from "@/lib/utils";

import { FileChip } from "./evidence";

/**
 * The answer to a dispute that is still waiting for one. Three ways out, the same
 * as Stripe's dashboard:
 *   - fight it: fill the evidence (saved as a draft as often as you like) and
 *     send it to the bank once;
 *   - accept it: the guest keeps the money;
 *   - refund instead: only while it is an inquiry and the payment can still be
 *     refunded, through the Sales tab's refund (same passcode, same ledger).
 *
 * The fields the bank needs for this kind of dispute come first; every other
 * field Stripe takes is one click away under "More evidence". Empty fields arrive
 * filled from our records (marked as such), never over anything already saved.
 */

type FileState = Record<FileField, EvidenceFile | null>;
type Confirm = "submit" | "accept" | "refund" | null;
type SaveResult = { ok: boolean; status: string };

const ALLOWED_TYPES: ReadonlySet<string> = new Set(FILE_ACCEPT.split(","));

export function EvidenceForm({
  detail,
  onChanged,
}: {
  detail: DisputeDetail;
  /** Reload the dispute after Stripe changed it. */
  onChanged: () => Promise<void>;
}) {
  const { dispute, evidence, prefill, facts } = detail;
  const recommended = useMemo(() => recommendedFields(dispute.reason), [dispute.reason]);

  const savedText = evidence.text;
  const [text, setText] = useState<Record<TextField, string>>(() => {
    const merged = { ...savedText };
    for (const key of TEXT_FIELD_KEYS) {
      if (!merged[key]?.trim() && prefill[key]) merged[key] = prefill[key]!;
    }
    return merged;
  });
  const [files, setFiles] = useState<FileState>(evidence.files);
  const [uploading, setUploading] = useState<Partial<Record<FileField, boolean>>>({});
  const [fileErrors, setFileErrors] = useState<Partial<Record<FileField, string>>>({});
  const [touched, setTouched] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // "More evidence" starts open when something in it is already filled in.
  const [showMore, setShowMore] = useState(() =>
    EVIDENCE_FIELDS.some(
      (f) => !recommended.has(f.key) && (f.kind === "text" ? savedText[f.key]?.trim() : evidence.files[f.key]),
    ),
  );

  const dirty =
    TEXT_FIELD_KEYS.some((k) => (text[k] ?? "").trim() !== (savedText[k] ?? "").trim()) ||
    FILE_FIELD_KEYS.some((k) => (files[k]?.id ?? null) !== (evidence.files[k]?.id ?? null));

  // Leaving with edits the owner typed would lose them; a pre-filled draft alone
  // is not worth a warning.
  useEffect(() => {
    if (!touched || !dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [touched, dirty]);

  const totalFileBytes = FILE_FIELD_KEYS.reduce((s, k) => s + (files[k]?.size ?? 0), 0);
  const filesTooBig = totalFileBytes > MAX_FILES_BYTES;
  const hasAnything =
    TEXT_FIELD_KEYS.some((k) => text[k]?.trim()) || FILE_FIELD_KEYS.some((k) => files[k]);
  const anyUploading = Object.values(uploading).some(Boolean);

  const setField = (key: TextField, value: string) => {
    setText((t) => ({ ...t, [key]: value }));
    setTouched(true);
    setNotice(null);
  };

  const upload = async (key: FileField, file: File) => {
    setFileErrors((e) => ({ ...e, [key]: undefined }));
    if (!ALLOWED_TYPES.has(file.type)) {
      setFileErrors((e) => ({ ...e, [key]: "Use a PDF, PNG or JPEG file." }));
      return;
    }
    if (totalFileBytes - (files[key]?.size ?? 0) + file.size > MAX_FILES_BYTES) {
      setFileErrors((e) => ({
        ...e,
        [key]: `Stripe takes ${fileSize(MAX_FILES_BYTES)} of files in total for a dispute. This one would go over.`,
      }));
      return;
    }
    setUploading((u) => ({ ...u, [key]: true }));
    const form = new FormData();
    form.append("dispute_id", dispute.id);
    form.append("file", file);
    const { data, error: uploadError } = await invokeStripeDisputes<{ file: EvidenceFile }>(form);
    setUploading((u) => ({ ...u, [key]: false }));
    if (uploadError || !data) {
      setFileErrors((e) => ({ ...e, [key]: uploadError ?? "The upload did not finish. Try again." }));
      return;
    }
    setFiles((f) => ({ ...f, [key]: data.file }));
    setTouched(true);
    setNotice(null);
  };

  const removeFile = (key: FileField) => {
    setFiles((f) => ({ ...f, [key]: null }));
    setTouched(true);
    setNotice(null);
  };

  /** The whole form as Stripe's evidence object; empty strings clear a field. */
  const payload = () => ({
    ...Object.fromEntries(TEXT_FIELD_KEYS.map((k) => [k, (text[k] ?? "").trim()])),
    ...Object.fromEntries(FILE_FIELD_KEYS.map((k) => [k, files[k]?.id ?? ""])),
  });

  const tooLong = TEXT_FIELD_KEYS.find((k) => (text[k] ?? "").length > MAX_TEXT_FIELD);

  async function save(submit: boolean) {
    setError(null);
    const { data, error: saveError } = await invokeStripeDisputes<SaveResult>({
      action: "save",
      dispute_id: dispute.id,
      evidence: payload(),
      submit,
    });
    if (saveError || !data) {
      setError(saveError ?? "Stripe did not confirm the save. Try again.");
      return false;
    }
    setTouched(false);
    setConfirm(null);
    setNotice(submit ? null : "Draft saved in Stripe. The bank has not seen it.");
    await onChanged();
    return true;
  }

  async function accept() {
    setError(null);
    const { error: acceptError } = await invokeStripeDisputes<SaveResult>({ action: "accept", dispute_id: dispute.id });
    if (acceptError) {
      setError(acceptError);
      return;
    }
    setTouched(false);
    setConfirm(null);
    await onChanged();
  }

  const recommendedSpecs = EVIDENCE_FIELDS.filter((f) => recommended.has(f.key));
  const moreSpecs = EVIDENCE_FIELDS.filter((f) => !recommended.has(f.key));
  const refundable = dispute.isChargeRefundable && detail.transactionId != null;
  const factsMissing = facts.trim() !== "" && !(text.uncategorized_text ?? "").includes(facts.trim());

  const renderField = (spec: FieldSpec) =>
    spec.kind === "text" ? (
      <TextFieldBlock
        key={spec.key}
        spec={spec}
        value={text[spec.key] ?? ""}
        prefilled={Boolean(prefill[spec.key]) && text[spec.key] === prefill[spec.key]}
        onChange={(v) => setField(spec.key, v)}
        action={
          spec.key === "uncategorized_text" && factsMissing ? (
            <button
              type="button"
              onClick={() => {
                const current = (text.uncategorized_text ?? "").trimEnd();
                setField("uncategorized_text", current ? `${current}\n\n${facts}` : facts);
              }}
              className="inline-flex items-center gap-1 text-xs font-medium text-indigo-700 hover:underline dark:text-indigo-300"
            >
              <Plus className="size-3.5" aria-hidden />
              Add the booking facts
            </button>
          ) : null
        }
      />
    ) : (
      <FileFieldBlock
        key={spec.key}
        spec={spec}
        disputeId={dispute.id}
        file={files[spec.key]}
        uploading={Boolean(uploading[spec.key])}
        error={fileErrors[spec.key]}
        onUpload={(f) => void upload(spec.key, f)}
        onRemove={() => removeFile(spec.key)}
      />
    );

  return (
    <section className="space-y-3">
      <div className="px-1">
        <h2 className="text-lg font-semibold tracking-tight">Your answer</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Send the bank proof that the payment is valid. Save a draft as often as you like; nothing reaches the
          bank until you send it, and it can only be sent once.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-6 py-6">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            What the bank needs for this kind of dispute
          </p>
          {recommendedSpecs.map(renderField)}
        </CardContent>
      </Card>

      <button
        type="button"
        onClick={() => setShowMore((v) => !v)}
        aria-expanded={showMore}
        className="flex items-center gap-1.5 px-1 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        {showMore ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        More evidence ({moreSpecs.length} more fields)
      </button>
      {showMore && (
        <Card>
          <CardContent className="space-y-6 py-6">{moreSpecs.map(renderField)}</CardContent>
        </Card>
      )}

      <div className="sticky bottom-0 z-10 -mx-1 rounded-xl border bg-background/95 px-4 py-3 shadow-sm backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirm("accept")}>
              Accept the dispute
            </Button>
            {refundable && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirm("refund")}>
                Refund instead
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className={cn("text-xs", filesTooBig ? "text-destructive" : "text-muted-foreground")}>
              Files {fileSize(totalFileBytes)} of {fileSize(MAX_FILES_BYTES)}
            </span>
            <span className="text-xs text-muted-foreground">{dirty ? "Not saved yet" : notice ?? "Saved"}</span>
            <form action={() => save(false).then(() => undefined)}>
              <SubmitButton variant="outline" disabled={!dirty || anyUploading || Boolean(tooLong)} pendingLabel="Saving">
                Save draft
              </SubmitButton>
            </form>
            <Button
              type="button"
              disabled={!hasAnything || anyUploading || filesTooBig || Boolean(tooLong)}
              onClick={() => {
                setError(null);
                setConfirm("submit");
              }}
            >
              Send to the bank
            </Button>
          </div>
        </div>
        {(error || tooLong) && !confirm && (
          <p className="mt-2 text-sm text-destructive">
            {error ?? "One answer is over 20,000 characters, the most Stripe takes for a field. Shorten it to save."}
          </p>
        )}
      </div>

      {confirm === "submit" && (
        <Dialog
          title="Send this answer to the bank?"
          description="Stripe takes one answer per dispute. After this, the bank decides."
          onClose={() => setConfirm(null)}
        >
          <SubmitSummary text={text} files={files} />
          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
          <form action={() => save(true).then(() => undefined)} className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setConfirm(null)}>
              Keep editing
            </Button>
            <SubmitButton pendingLabel="Sending">Send to the bank</SubmitButton>
          </form>
        </Dialog>
      )}

      {confirm === "accept" && (
        <Dialog
          title="Accept this dispute?"
          description="The dispute closes and cannot be reopened."
          onClose={() => setConfirm(null)}
        >
          <p className="text-sm">
            The guest keeps {money(dispute.amount, dispute.currency)}.
            {dispute.money.fees > 0 && <> The {money(dispute.money.fees)} dispute fee is not returned.</>}{" "}
            Accept only if the guest is right or the amount is not worth fighting.
          </p>
          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
          <form action={accept} className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setConfirm(null)}>
              Go back
            </Button>
            <SubmitButton variant="destructive" pendingLabel="Accepting">
              Accept the dispute
            </SubmitButton>
          </form>
        </Dialog>
      )}

      {confirm === "refund" && detail.transactionId && (
        <RefundDialog
          transactionId={detail.transactionId}
          maxCents={Math.min(dispute.amount, (detail.payment?.amount ?? dispute.amount) - (detail.payment?.amountRefunded ?? 0))}
          onClose={() => setConfirm(null)}
          onDone={async () => {
            setConfirm(null);
            await onChanged();
          }}
        />
      )}
    </section>
  );
}

// ── Fields ───────────────────────────────────────────────────────────────────

function TextFieldBlock({
  spec,
  value,
  prefilled,
  onChange,
  action,
}: {
  spec: Extract<FieldSpec, { kind: "text" }>;
  value: string;
  prefilled: boolean;
  onChange: (value: string) => void;
  action?: React.ReactNode;
}) {
  const id = useId();
  const long = value.length > MAX_TEXT_FIELD * 0.8;
  return (
    <Field label={spec.label} htmlFor={id} hint={spec.hint}>
      {spec.rows ? (
        <Textarea id={id} rows={spec.rows} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
      {(prefilled || action || long) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-3">
            {prefilled && (
              <span className="text-xs text-amber-700 dark:text-amber-300">
                Filled in from our records. Check it before sending.
              </span>
            )}
            {action}
          </div>
          {long && (
            <span className={cn("text-xs", value.length > MAX_TEXT_FIELD ? "text-destructive" : "text-muted-foreground")}>
              {value.length.toLocaleString()} / {MAX_TEXT_FIELD.toLocaleString()}
            </span>
          )}
        </div>
      )}
    </Field>
  );
}

function FileFieldBlock({
  spec,
  disputeId,
  file,
  uploading,
  error,
  onUpload,
  onRemove,
}: {
  spec: Extract<FieldSpec, { kind: "file" }>;
  disputeId: string;
  file: EvidenceFile | null;
  uploading: boolean;
  error?: string;
  onUpload: (file: File) => void;
  onRemove: () => void;
}) {
  const id = useId();
  return (
    <Field label={spec.label} htmlFor={id} hint={spec.hint} error={error}>
      {file ? (
        <FileChip disputeId={disputeId} file={file} onRemove={onRemove} disabled={uploading} />
      ) : (
        <label
          htmlFor={id}
          className={cn(
            "flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed px-3 py-3 text-sm text-muted-foreground transition hover:border-foreground/30 hover:text-foreground",
            uploading && "pointer-events-none opacity-70",
          )}
        >
          {uploading ? (
            <>
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
              Uploading to Stripe
            </>
          ) : (
            <>
              <Upload className="size-4" aria-hidden />
              Upload a PDF, PNG or JPEG
            </>
          )}
          <input
            id={id}
            type="file"
            accept={FILE_ACCEPT}
            className="sr-only"
            disabled={uploading}
            onChange={(e) => {
              const picked = e.target.files?.[0];
              e.target.value = ""; // the same file can be picked again after a removal
              if (picked) onUpload(picked);
            }}
          />
        </label>
      )}
    </Field>
  );
}

// ── Dialogs ──────────────────────────────────────────────────────────────────

/** What is about to be sent, so the owner sends with eyes open. */
function SubmitSummary({ text, files }: { text: Record<TextField, string>; files: FileState }) {
  const filledText = EVIDENCE_FIELDS.filter((f) => f.kind === "text" && text[f.key as TextField]?.trim());
  const attached = EVIDENCE_FIELDS.filter((f) => f.kind === "file" && files[f.key as FileField]);
  return (
    <div className="space-y-3 text-sm">
      <div>
        <p className="font-medium">
          {filledText.length} answer{filledText.length === 1 ? "" : "s"}
        </p>
        <p className="text-muted-foreground">{filledText.map((f) => f.label).join(", ") || "None"}</p>
      </div>
      <div>
        <p className="font-medium">
          {attached.length} document{attached.length === 1 ? "" : "s"}
        </p>
        <p className="text-muted-foreground">
          {attached.map((f) => files[f.key as FileField]!.filename).join(", ") || "None"}
        </p>
      </div>
    </div>
  );
}

/**
 * Refund while the dispute is still an inquiry. Goes through the payments
 * function's card refund (the Sales tab's), so it asks for the same passcode and
 * updates the same ledger.
 */
function RefundDialog({
  transactionId,
  maxCents,
  onClose,
  onDone,
}: {
  transactionId: string;
  maxCents: number;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pinId = useId();

  async function refund() {
    setError(null);
    const { error: refundError } = await invokeEdgeFunction("payments", {
      action: "refund_card",
      id: transactionId,
      amount_cents: maxCents,
      pin: pin.trim(),
    });
    if (refundError) {
      setError(refundError);
      return;
    }
    await onDone();
  }

  return (
    <Dialog
      title="Refund the guest instead?"
      description="Refunding now usually closes the inquiry before it becomes a chargeback."
      onClose={onClose}
    >
      <form action={refund} className="space-y-4">
        <p className="text-sm">
          The guest gets {money(maxCents)} back on their card. Stripe&apos;s fee on the payment is not returned.
        </p>
        <Field label="Refund passcode" htmlFor={pinId}>
          {/* Masked with CSS, as on the Sales tab: a password field makes browsers
              offer to save this shared passcode. */}
          <Input
            id={pinId}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            data-1p-ignore=""
            data-lpignore="true"
            style={{ WebkitTextSecurity: "disc" } as CSSProperties}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
        </Field>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Go back
          </Button>
          <SubmitButton variant="destructive" disabled={!pin.trim() || maxCents <= 0} pendingLabel="Refunding">
            Refund {money(maxCents)}
          </SubmitButton>
        </div>
      </form>
    </Dialog>
  );
}
