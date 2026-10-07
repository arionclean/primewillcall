import { invokeStripeFunction } from "@/lib/payments/edge";
import type { Tone } from "@/lib/payments/stripe-reports";

/**
 * The owner's Disputes tab: the shapes the `stripe-disputes` edge function
 * answers with, every evidence field Stripe takes (in plain words), what to send
 * for each kind of dispute, and the words the screen uses for Stripe's codes.
 *
 * The field keys must match the function's TEXT_FIELDS / FILE_FIELDS, which
 * validate every save; a key missing there is refused, not silently dropped.
 */

export function invokeStripeDisputes<T>(
  body: Record<string, unknown> | FormData,
): Promise<{ data: T | null; error: string | null }> {
  return invokeStripeFunction<T>("stripe-disputes", body);
}

// ── Shapes ───────────────────────────────────────────────────────────────────

export type DisputeBucket = "needs_response" | "under_review" | "won" | "lost" | "closed";

export type EvidenceFile = { id: string; filename: string; size: number; type: string | null };

export type DisputeDetail = {
  dispute: {
    id: string;
    status: string;
    reason: string;
    amount: number;
    currency: string;
    created: string;
    networkReasonCode: string | null;
    cardBrand: string | null;
    /** The early stage: the bank is asking, no money has been taken yet. */
    isInquiry: boolean;
    isChargeRefundable: boolean;
    /** The bank is waiting for an answer (needs_response or the inquiry version). */
    answerable: boolean;
    dueBy: string | null;
    pastDue: boolean;
    hasEvidence: boolean;
    submissionCount: number;
    /** Cents. What Stripe took from the business, and what came back. */
    money: { withdrawn: number; fees: number; reinstated: number; feesReturned: number };
  };
  evidence: {
    text: Record<TextField, string>;
    files: Record<FileField, EvidenceFile | null>;
  };
  /** Drafts from our records, only for fields that are still empty. */
  prefill: Partial<Record<TextField, string>>;
  /** The booking and payment facts as plain sentences, to add to the explanation. */
  facts: string;
  payment: {
    id: string;
    amount: number;
    amountRefunded: number;
    created: string;
    brand: string | null;
    last4: string | null;
    country: string | null;
    funding: string | null;
    wallet: string | null;
    cardPresent: boolean;
    readMethod: string | null;
    cvcCheck: string | null;
    addressCheck: string | null;
    postalCheck: string | null;
    threeDSecure: string | null;
    riskLevel: string | null;
    descriptor: string | null;
    receiptUrl: string | null;
    billingName: string | null;
    billingEmail: string | null;
    billingAddress: string | null;
  } | null;
  booking: {
    id: string;
    startsAt: string;
    checkedInAt: string | null;
    status: string;
    tourName: string | null;
    businessName: string | null;
    guests: string | null;
    totalCents: number | null;
    ref: string | null;
    source: string | null;
  } | null;
  guest: { name: string | null; email: string | null; phone: string | null } | null;
  /** Our ledger row for the charge; a refund goes through it. */
  transactionId: string | null;
  accountId: string;
};

// ── Evidence fields ──────────────────────────────────────────────────────────

export type TextField =
  | "uncategorized_text"
  | "product_description"
  | "service_date"
  | "customer_name"
  | "customer_email_address"
  | "billing_address"
  | "customer_purchase_ip"
  | "access_activity_log"
  | "refund_policy_disclosure"
  | "refund_refusal_explanation"
  | "cancellation_policy_disclosure"
  | "cancellation_rebuttal"
  | "duplicate_charge_id"
  | "duplicate_charge_explanation";

export type FileField =
  | "receipt"
  | "service_documentation"
  | "customer_communication"
  | "customer_signature"
  | "refund_policy"
  | "cancellation_policy"
  | "duplicate_charge_documentation"
  | "uncategorized_file";

export type FieldSpec =
  | { key: TextField; kind: "text"; label: string; hint: string; rows?: number }
  | { key: FileField; kind: "file"; label: string; hint: string };

/** Every field, in the order the form shows them. */
export const EVIDENCE_FIELDS: FieldSpec[] = [
  {
    key: "uncategorized_text",
    kind: "text",
    label: "Your explanation",
    hint: "Tell the bank why this payment is valid. Stick to facts: what was booked, when, and that the guest took the tour.",
    rows: 8,
  },
  {
    key: "product_description",
    kind: "text",
    label: "What the guest bought",
    hint: "The tour, the date and time, and how many guests.",
    rows: 3,
  },
  { key: "service_date", kind: "text", label: "Date of the tour", hint: "The day the tour ran, for example September 4, 2026." },
  {
    key: "service_documentation",
    kind: "file",
    label: "Proof the tour happened",
    hint: "A check-in record, a manifest with the guest's name, or a photo from the tour.",
  },
  { key: "receipt", kind: "file", label: "Receipt", hint: "The receipt or booking confirmation the guest received." },
  {
    key: "customer_communication",
    kind: "file",
    label: "Messages with the guest",
    hint: "Texts or emails where the guest confirms the booking or talks about the tour.",
  },
  { key: "customer_name", kind: "text", label: "Guest name", hint: "As it appears on the booking." },
  { key: "customer_email_address", kind: "text", label: "Guest email", hint: "The email on the booking or receipt." },
  { key: "billing_address", kind: "text", label: "Billing address", hint: "As the guest entered it, if you have it." },
  { key: "customer_signature", kind: "file", label: "Guest signature", hint: "A signed waiver, ticket or receipt." },
  { key: "refund_policy", kind: "file", label: "Refund policy", hint: "Your written refund policy." },
  {
    key: "refund_policy_disclosure",
    kind: "text",
    label: "How the guest saw the refund policy",
    hint: "Where it is shown: the booking page, the receipt, a sign at the ticket desk.",
    rows: 3,
  },
  {
    key: "refund_refusal_explanation",
    kind: "text",
    label: "Why no refund is owed",
    hint: "For example: the guest took the tour, or asked after the refund window closed.",
    rows: 3,
  },
  { key: "cancellation_policy", kind: "file", label: "Cancellation policy", hint: "Your written cancellation policy." },
  {
    key: "cancellation_policy_disclosure",
    kind: "text",
    label: "How the guest saw the cancellation policy",
    hint: "Where it is shown to guests before they pay.",
    rows: 3,
  },
  {
    key: "cancellation_rebuttal",
    kind: "text",
    label: "Why the cancellation does not apply",
    hint: "For example: the guest never cancelled, or cancelled too late under the policy.",
    rows: 3,
  },
  {
    key: "duplicate_charge_id",
    kind: "text",
    label: "The other payment",
    hint: "If the guest says they were charged twice: the Stripe ID of the other payment (starts with ch_ or py_).",
  },
  {
    key: "duplicate_charge_explanation",
    kind: "text",
    label: "Why these are two different purchases",
    hint: "For example: two separate tours, or two different dates.",
    rows: 3,
  },
  {
    key: "duplicate_charge_documentation",
    kind: "file",
    label: "Proof of the other purchase",
    hint: "A receipt for the other payment showing it was a separate purchase.",
  },
  {
    key: "customer_purchase_ip",
    kind: "text",
    label: "Guest's IP address",
    hint: "Only for online bookings, and only if you have it.",
  },
  {
    key: "access_activity_log",
    kind: "text",
    label: "Online activity",
    hint: "Any record of the guest using what they bought online, like opening their ticket.",
    rows: 3,
  },
  { key: "uncategorized_file", kind: "file", label: "Other document", hint: "Anything else that supports your answer." },
];

export const TEXT_FIELD_KEYS = EVIDENCE_FIELDS.filter((f) => f.kind === "text").map((f) => f.key as TextField);
export const FILE_FIELD_KEYS = EVIDENCE_FIELDS.filter((f) => f.kind === "file").map((f) => f.key as FileField);

/**
 * What to send for each kind of dispute, following Stripe's guidance per
 * category. These show first; every other field sits under "More evidence".
 */
const RECOMMENDED: Record<string, (TextField | FileField)[]> = {
  product_unacceptable: [
    "uncategorized_text", "product_description", "service_date", "service_documentation",
    "refund_policy", "refund_policy_disclosure", "refund_refusal_explanation", "customer_communication", "receipt",
  ],
  product_not_received: [
    "uncategorized_text", "product_description", "service_date", "service_documentation", "customer_communication", "receipt",
  ],
  credit_not_processed: [
    "uncategorized_text", "refund_policy", "refund_policy_disclosure", "refund_refusal_explanation",
    "customer_communication", "receipt",
  ],
  duplicate: [
    "uncategorized_text", "duplicate_charge_id", "duplicate_charge_explanation", "duplicate_charge_documentation", "receipt",
  ],
  fraudulent: [
    "uncategorized_text", "customer_name", "customer_email_address", "billing_address", "product_description",
    "service_date", "service_documentation", "receipt", "customer_signature", "customer_communication",
  ],
  unrecognized: [
    "uncategorized_text", "product_description", "service_date", "customer_name", "customer_email_address", "receipt",
  ],
  subscription_canceled: [
    "uncategorized_text", "cancellation_policy", "cancellation_policy_disclosure", "cancellation_rebuttal",
    "customer_communication",
  ],
};
const RECOMMENDED_DEFAULT: (TextField | FileField)[] = [
  "uncategorized_text", "product_description", "service_date", "service_documentation", "receipt", "customer_communication",
];

export function recommendedFields(reason: string): Set<TextField | FileField> {
  return new Set(RECOMMENDED[reason] ?? RECOMMENDED_DEFAULT);
}

/** Stripe's limits, mirrored so the form can warn before the function refuses. */
export const MAX_TEXT_FIELD = 20_000;
export const MAX_FILES_BYTES = Math.floor(4.5 * 1024 * 1024);
export const FILE_ACCEPT = "application/pdf,image/png,image/jpeg";

// ── Words for Stripe's codes ─────────────────────────────────────────────────

export function disputeStatus(status: string): { label: string; tone: Tone } {
  switch (status) {
    case "needs_response":
      return { label: "Needs an answer", tone: "danger" };
    case "warning_needs_response":
      return { label: "Inquiry, needs an answer", tone: "danger" };
    case "under_review":
    case "warning_under_review":
      return { label: "Waiting on the bank", tone: "info" };
    case "won":
      return { label: "Won", tone: "success" };
    case "lost":
      return { label: "Lost", tone: "neutral" };
    case "warning_closed":
      return { label: "Inquiry closed", tone: "neutral" };
    case "charge_refunded":
      return { label: "Refunded", tone: "neutral" };
    default:
      return { label: "Closed", tone: "neutral" };
  }
}

/** One sentence on where the dispute stands and what happens next. */
export function disputeStatusExplainer(status: string, amount: string): string {
  switch (status) {
    case "needs_response":
      return `The bank has taken ${amount} back from the business while it decides. Send evidence before the deadline, or accept and the guest keeps the money.`;
    case "warning_needs_response":
      return "The guest's bank is asking about this payment. No money has been taken yet. Answer it, or refund the guest, so it does not turn into a chargeback.";
    case "under_review":
      return "Your evidence is with the bank. Banks usually decide within 60 to 75 days. There is nothing to do until then.";
    case "warning_under_review":
      return "Your answer to the inquiry was sent. The bank may close it, or turn it into a chargeback.";
    case "won":
      return "The bank decided in the business's favor and the money came back.";
    case "lost":
      return "The bank decided for the guest. The money stays with them.";
    case "warning_closed":
      return "The bank closed the inquiry without taking any money.";
    case "charge_refunded":
      return "The guest was refunded, so the dispute closed.";
    default:
      return "This dispute is closed.";
  }
}

/** What the guest told their bank, in plain words. */
export function disputeReason(reason: string): string {
  switch (reason) {
    case "duplicate":
      return "Says they were charged twice";
    case "fraudulent":
      return "Card owner says they did not make this payment";
    case "product_not_received":
      return "Says they never got the tour";
    case "product_unacceptable":
      return "Not happy with the tour";
    case "credit_not_processed":
      return "Says a refund was promised and never came";
    case "subscription_canceled":
      return "Says they cancelled";
    case "unrecognized":
      return "Does not recognize the charge";
    case "bank_cannot_process":
      return "The bank could not process the payment";
    case "check_returned":
    case "debit_not_authorized":
    case "incorrect_account_details":
    case "insufficient_funds":
      return "Problem with the guest's account";
    case "customer_initiated":
      return "The guest asked their bank to reverse it";
    default:
      return "Other reason";
  }
}

/** A Stripe check result ("pass", "fail", "unavailable", ...) in words. */
export function checkResult(value: string | null): string | null {
  switch (value) {
    case "pass":
      return "Matched";
    case "fail":
      return "Did not match";
    case "unavailable":
    case "unchecked":
      return "Not checked";
    case "authenticated":
      return "Verified by the bank";
    case "attempt_acknowledged":
      return "Attempted";
    case "failed":
    case "not_supported":
    case "processing_error":
      return "Not verified";
    default:
      return null;
  }
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
