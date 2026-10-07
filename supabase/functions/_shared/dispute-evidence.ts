/**
 * The rules for answering a dispute, kept apart from the edge function so they
 * can be tested on their own (dispute-evidence.test.ts) and against Stripe's
 * test mode (dispute-evidence.sandbox.test.ts).
 *
 * Money is at stake and Stripe takes ONE submission per dispute, so two rules
 * here matter more than the rest:
 *   - `submit` is always sent explicitly. Stripe's default for it is TRUE: an
 *     update that leaves it out goes straight to the bank. A draft must say
 *     `submit: false`.
 *   - Only the fields the screen knows are ever sent. Stripe updates only the
 *     keys it receives, so anything else on the dispute is left untouched.
 */

import type Stripe from "npm:stripe@22.3.0";

/** The two statuses where the bank is still waiting for an answer. */
export const ANSWERABLE_STATUSES: ReadonlySet<string> = new Set([
  "needs_response",
  "warning_needs_response",
]);

// Every field Stripe takes on a dispute except the shipping ones (tours do not
// ship) and Visa's enhanced evidence (it needs prior undisputed payments from the
// same card, which a tour desk does not have). The screen's list
// (src/lib/payments/disputes.ts) must match; a test checks it.

export const TEXT_FIELDS = [
  "access_activity_log",
  "billing_address",
  "cancellation_policy_disclosure",
  "cancellation_rebuttal",
  "customer_email_address",
  "customer_name",
  "customer_purchase_ip",
  "duplicate_charge_explanation",
  "duplicate_charge_id",
  "product_description",
  "refund_policy_disclosure",
  "refund_refusal_explanation",
  "service_date",
  "uncategorized_text",
] as const;

export const FILE_FIELDS = [
  "cancellation_policy",
  "customer_communication",
  "customer_signature",
  "duplicate_charge_documentation",
  "receipt",
  "refund_policy",
  "service_documentation",
  "uncategorized_file",
] as const;

export type TextField = (typeof TEXT_FIELDS)[number];
export type FileField = (typeof FILE_FIELDS)[number];

const TEXT_SET: ReadonlySet<string> = new Set(TEXT_FIELDS);
const FILE_SET: ReadonlySet<string> = new Set(FILE_FIELDS);

/** Stripe's own limits on dispute evidence. */
export const MAX_TEXT_FIELD = 20_000;
export const MAX_TEXT_TOTAL = 150_000;
export const MAX_FILE_BYTES = Math.floor(4.5 * 1024 * 1024);
export const FILE_TYPES: ReadonlySet<string> = new Set(["application/pdf", "image/png", "image/jpeg"]);

export const DISPUTE_ID_RE = /^(du|dp)_[A-Za-z0-9]+$/;
export const FILE_ID_RE = /^file_[A-Za-z0-9]+$/;

export type CleanedEvidence = { evidence: Record<string, string> } | { error: string };

/**
 * Check the evidence the screen sent and turn it into Stripe's evidence object.
 * Text is trimmed; an empty string clears a field (text or file) on Stripe.
 */
export function cleanEvidence(input: unknown): CleanedEvidence {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "Nothing to save." };
  const evidence: Record<string, string> = {};
  let total = 0;
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (typeof raw !== "string") return { error: `${key} must be text.` };
    if (TEXT_SET.has(key)) {
      const value = raw.trim();
      if (value.length > MAX_TEXT_FIELD) {
        return { error: "One of the answers is longer than Stripe allows (20,000 characters)." };
      }
      total += value.length;
      evidence[key] = value;
    } else if (FILE_SET.has(key)) {
      if (raw !== "" && !FILE_ID_RE.test(raw)) return { error: "One of the files is not valid. Upload it again." };
      evidence[key] = raw;
    } else {
      return { error: `Unknown evidence field: ${key}` };
    }
  }
  if (total > MAX_TEXT_TOTAL) {
    return { error: "The answers add up to more text than Stripe allows (150,000 characters)." };
  }
  return { evidence };
}

/** True when at least one field carries something worth sending to the bank. */
export function hasEvidence(evidence: Record<string, string>): boolean {
  return Object.values(evidence).some((v) => v !== "");
}

/**
 * The parameters for Stripe's dispute update. `submit` is required here on
 * purpose: Stripe treats a missing `submit` as true and sends the answer.
 */
export function evidenceUpdate(
  evidence: Record<string, string>,
  submit: boolean,
  staffId: string,
): Stripe.DisputeUpdateParams {
  return {
    evidence: evidence as Stripe.DisputeUpdateParams.Evidence,
    submit,
    metadata: { pwc_last_saved_by: staffId },
  };
}
