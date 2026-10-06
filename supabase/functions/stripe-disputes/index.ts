// Stripe disputes for the owner's Disputes tab on /admin/payments.
//
// Everything the owner could do with a dispute in Stripe's dashboard, from here:
//
//   sync     Every dispute on every business account into stripe_disputes (the
//            list's copy). Run when the tab opens; also the backfill.
//   detail   One dispute in full: status, deadline, money taken and fees, the
//            payment (card, how it was read, the checks), our booking and guest,
//            the evidence saved so far (text and files), and a draft of the
//            facts we know, for the fields still empty.
//   upload   One evidence file (PDF, PNG or JPEG) to the business's account. It
//            is not part of the answer until `save` names it.
//   file     The bytes of an evidence file, so the owner can open what was sent.
//   save     Store the evidence on the dispute; with `submit` it goes to the
//            bank. Stripe takes one submission, so the screen confirms first.
//   accept   Give up the dispute: the guest keeps the money.
//
// A refund instead (only possible while the bank is still asking, the "inquiry"
// stage) goes through the payments function's refund_card, which owns the refund
// passcode and the ledger update.
//
// Deployed with JWT ON. Owner only (the owner's call, 2026-10-06). `sync` also
// accepts the service role key, so it can be run from a terminal; anything that
// changes a dispute needs a signed-in owner, because the activity log names them.
//
// Secrets: STRIPE_SECRET_KEY (Prime's PLATFORM key). Disputes on direct charges
// live on the business's connected account, so every call passes it.

import type Stripe from "npm:stripe@22.3.0";

import { employeeFromRequest, logStaffAction } from "../_shared/audit.ts";
import { BROWSER_PREFLIGHT_HEADERS } from "../_shared/browser-cors.ts";
import { corsHeaders, db, json } from "../_shared/sms.ts";
import { requireStaff, type Staff } from "../_shared/staff-auth.ts";
import { withSentry } from "../_shared/sentry.ts";
import {
  downloadStripeFile,
  getStripe,
  stripeConfigured,
  stripeErrorMessage,
  uploadDisputeEvidenceFile,
} from "../_shared/stripe.ts";
import { ANSWERABLE_STATUSES, upsertDisputes } from "../_shared/stripe-disputes.ts";

type Action = "sync" | "detail" | "upload" | "file" | "save" | "accept";

// ── Evidence fields ──────────────────────────────────────────────────────────
// Every field Stripe takes on a dispute except the shipping ones (tours do not
// ship) and Visa's enhanced evidence (needs prior undisputed payments from the
// same card, which a tour desk does not have).

const TEXT_FIELDS = [
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

const FILE_FIELDS = [
  "cancellation_policy",
  "customer_communication",
  "customer_signature",
  "duplicate_charge_documentation",
  "receipt",
  "refund_policy",
  "service_documentation",
  "uncategorized_file",
] as const;

type TextField = (typeof TEXT_FIELDS)[number];
type FileField = (typeof FILE_FIELDS)[number];

const TEXT_SET: ReadonlySet<string> = new Set(TEXT_FIELDS);
const FILE_SET: ReadonlySet<string> = new Set(FILE_FIELDS);

/** Stripe's own limits on dispute evidence. */
const MAX_TEXT_FIELD = 20_000;
const MAX_TEXT_TOTAL = 150_000;
const MAX_FILE_BYTES = Math.floor(4.5 * 1024 * 1024);
const FILE_TYPES: ReadonlySet<string> = new Set(["application/pdf", "image/png", "image/jpeg"]);

const DISPUTE_ID_RE = /^(du|dp)_[A-Za-z0-9]+$/;
const FILE_ID_RE = /^file_[A-Za-z0-9]+$/;

// ── Helpers ──────────────────────────────────────────────────────────────────

interface DisputeRow {
  stripe_dispute_id: string;
  business_id: string | null;
  connected_account_id: string;
  transaction_id: string | null;
  booking_id: string | null;
}

async function loadRow(disputeId: string): Promise<DisputeRow | null> {
  if (!DISPUTE_ID_RE.test(disputeId)) return null;
  const { data } = await db
    .from("stripe_disputes")
    .select("stripe_dispute_id, business_id, connected_account_id, transaction_id, booking_id")
    .eq("stripe_dispute_id", disputeId)
    .maybeSingle();
  return (data as DisputeRow | null) ?? null;
}

/**
 * True when the caller sent the service role key. The gateway (verify_jwt ON) has
 * already checked the token's signature, so its `role` claim can be trusted.
 */
function isServiceRoleToken(req: Request): boolean {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const part = token.split(".")[1];
  if (!part) return false;
  try {
    const claims = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    return claims?.role === "service_role";
  } catch {
    return false;
  }
}

const nyDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "long",
  day: "numeric",
  year: "numeric",
});
const nyTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
});

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function formatAddress(a: Stripe.Address | null | undefined): string | null {
  if (!a) return null;
  const line = [a.line1, a.line2, a.city, [a.state, a.postal_code].filter(Boolean).join(" "), a.country]
    .filter((p) => p && String(p).trim())
    .join(", ");
  return line || null;
}

/** How the card was read at the desk, in words, for a card-present payment. */
function readMethodText(method: string | null | undefined): string | null {
  switch (method) {
    case "contact_emv":
      return "Chip card inserted at the desk";
    case "contactless_emv":
    case "contactless_magstripe_mode":
      return "Card or phone tapped at the desk";
    case "magnetic_stripe_track2":
    case "magnetic_stripe_fallback":
      return "Card swiped at the desk";
    default:
      return null;
  }
}

// ── sync ─────────────────────────────────────────────────────────────────────

async function sync(stripe: Stripe): Promise<Response> {
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name, stripe_account_id, stripe_account_id_legacy")
    .not("stripe_account_id", "is", null);

  const accounts = (businesses ?? []).flatMap((b) =>
    [b.stripe_account_id as string, ...((b.stripe_account_id_legacy as string[] | null) ?? [])]
      .filter((id, i, all) => id && all.indexOf(id) === i)
      .map((accountId) => ({ accountId, businessId: b.id as string, name: b.name as string }))
  );

  const results = await Promise.all(accounts.map(async ({ accountId, businessId, name }) => {
    try {
      const items = [];
      for await (const d of stripe.disputes.list({ limit: 100 }, { stripeAccount: accountId })) {
        items.push({ dispute: d, accountId, businessId });
      }
      await upsertDisputes(db, items);
      return { business: name, account: accountId, disputes: items.length, error: null };
    } catch (err) {
      console.error(`[stripe-disputes] sync failed for ${accountId}:`, err);
      return { business: name, account: accountId, disputes: 0, error: stripeErrorMessage(err) };
    }
  }));

  return json({ ok: results.every((r) => !r.error), accounts: results });
}

// ── detail ───────────────────────────────────────────────────────────────────

async function detail(stripe: Stripe, row: DisputeRow): Promise<Response> {
  const opts = { stripeAccount: row.connected_account_id };

  let dispute: Stripe.Dispute;
  try {
    dispute = await stripe.disputes.retrieve(row.stripe_dispute_id, { expand: ["charge"] }, opts);
  } catch (err) {
    console.error("[stripe-disputes] retrieve failed:", err);
    return json({ error: stripeErrorMessage(err) }, 502);
  }
  // The list's copy follows whatever Stripe says now.
  await upsertDisputes(db, [{ dispute, accountId: row.connected_account_id, businessId: row.business_id }]);

  const evidence = dispute.evidence as unknown as Record<string, unknown>;
  const text = Object.fromEntries(
    TEXT_FIELDS.map((f) => [f, typeof evidence[f] === "string" ? (evidence[f] as string) : ""]),
  ) as Record<TextField, string>;

  const files = Object.fromEntries(
    await Promise.all(FILE_FIELDS.map(async (f) => {
      const value = evidence[f];
      const fileId = typeof value === "string" ? value : (value as { id?: string } | null)?.id ?? null;
      if (!fileId) return [f, null];
      try {
        const file = await stripe.files.retrieve(fileId, {}, opts);
        return [f, { id: file.id, filename: file.filename ?? file.id, size: file.size, type: file.type ?? null }];
      } catch {
        return [f, { id: fileId, filename: fileId, size: 0, type: null }];
      }
    })),
  ) as Record<FileField, { id: string; filename: string; size: number; type: string | null } | null>;

  // ── The payment ──
  const charge = typeof dispute.charge === "object" ? dispute.charge : null;
  const card = charge?.payment_method_details?.card;
  const present = charge?.payment_method_details?.card_present;
  const paymentSummary = charge
    ? {
      id: charge.id,
      amount: charge.amount,
      amountRefunded: charge.amount_refunded,
      created: new Date(charge.created * 1000).toISOString(),
      brand: card?.brand ?? present?.brand ?? null,
      last4: card?.last4 ?? present?.last4 ?? null,
      country: card?.country ?? present?.country ?? null,
      funding: card?.funding ?? present?.funding ?? null,
      wallet: card?.wallet?.type ?? present?.wallet?.type ?? null,
      cardPresent: Boolean(present),
      readMethod: readMethodText(present?.read_method),
      cvcCheck: card?.checks?.cvc_check ?? null,
      addressCheck: card?.checks?.address_line1_check ?? null,
      postalCheck: card?.checks?.address_postal_code_check ?? null,
      threeDSecure: card?.three_d_secure?.result ?? null,
      riskLevel: charge.outcome?.risk_level ?? null,
      descriptor: charge.calculated_statement_descriptor ?? null,
      receiptUrl: charge.receipt_url ?? null,
      billingName: charge.billing_details?.name ?? null,
      billingEmail: charge.billing_details?.email ?? charge.receipt_email ?? null,
      billingAddress: formatAddress(charge.billing_details?.address),
    }
    : null;

  // ── Our booking and guest ──
  type BookingRow = {
    id: string;
    starts_at: string;
    checked_in_at: string | null;
    status: string;
    voided_at: string | null;
    pax_adult: number | null;
    pax_child: number | null;
    pax_infant: number | null;
    total_cents: number | null;
    legacy_id: string | null;
    customer: { full_name: string | null; email: string | null; phone: string | null } | null;
    business_tour: { name: string | null } | null;
    business: { name: string | null } | null;
  };
  let booking: BookingRow | null = null;
  if (row.booking_id) {
    const { data } = await db
      .from("bookings")
      .select(
        "id, starts_at, checked_in_at, status, voided_at, pax_adult, pax_child, pax_infant, total_cents, legacy_id, customer:customers(full_name, email, phone), business_tour:business_tours(name), business:businesses(name)",
      )
      .eq("id", row.booking_id)
      .maybeSingle();
    booking = (data as unknown as BookingRow | null) ?? null;
  }
  let source: string | null = null;
  let bookingRef: string | null = null;
  if (row.transaction_id) {
    const { data } = await db
      .from("stripe_transactions")
      .select("source, booking_ref")
      .eq("id", row.transaction_id)
      .maybeSingle();
    source = data?.source ?? null;
    bookingRef = data?.booking_ref ?? null;
  }

  const guests = booking
    ? [
      booking.pax_adult ? plural(booking.pax_adult, "adult") : null,
      booking.pax_child ? plural(booking.pax_child, "child", "children") : null,
      booking.pax_infant ? plural(booking.pax_infant, "infant") : null,
    ].filter(Boolean).join(", ") || null
    : null;
  const tourName = booking?.business_tour?.name ?? null;
  const ref = bookingRef ?? booking?.legacy_id ?? null;

  // ── What we know, as evidence drafts ──
  const facts: string[] = [];
  if (booking && tourName) {
    const when = new Date(booking.starts_at);
    facts.push(
      `${ref ? `Booking ${ref}: ` : ""}${tourName} on ${nyDate.format(when)} at ${nyTime.format(when)} (New York time)${guests ? `, ${guests}` : ""}.`,
    );
  }
  if (paymentSummary) {
    const paid = new Date(paymentSummary.created);
    const how = paymentSummary.readMethod ? ` ${paymentSummary.readMethod.toLowerCase()}` : "";
    facts.push(
      `Paid ${dollars(paymentSummary.amount)} by ${paymentSummary.brand ? `${paymentSummary.brand.toUpperCase()} ` : ""}card${paymentSummary.last4 ? ` ending ${paymentSummary.last4}` : ""} on ${nyDate.format(paid)} at ${nyTime.format(paid)}${how ? `,${how}` : ""}.`,
    );
  }
  if (booking?.checked_in_at) {
    const at = new Date(booking.checked_in_at);
    facts.push(`The guest checked in for the tour on ${nyDate.format(at)} at ${nyTime.format(at)}.`);
  }
  if (paymentSummary && paymentSummary.amountRefunded > 0) {
    facts.push(`${dollars(paymentSummary.amountRefunded)} of this payment was already refunded.`);
  }

  const suggestions: Partial<Record<TextField, string>> = {
    customer_name: booking?.customer?.full_name ?? paymentSummary?.billingName ?? undefined,
    customer_email_address: booking?.customer?.email ?? paymentSummary?.billingEmail ?? undefined,
    billing_address: paymentSummary?.billingAddress ?? undefined,
    service_date: booking ? nyDate.format(new Date(booking.starts_at)) : undefined,
    product_description: tourName && booking
      ? `${tourName}, a scheduled tour${booking.business?.name ? ` run by ${booking.business.name}` : ""}. ${guests ? `${guests[0].toUpperCase()}${guests.slice(1)} ` : "Booked "}for ${nyDate.format(new Date(booking.starts_at))} at ${nyTime.format(new Date(booking.starts_at))} (New York time).`
      : undefined,
    uncategorized_text: facts.length > 0 ? facts.join("\n") : undefined,
  };
  // Only for fields still empty: a draft never overwrites what is already saved.
  const prefill = Object.fromEntries(
    Object.entries(suggestions).filter(([f, v]) => v && !text[f as TextField]?.trim()),
  );

  const withdrawn = dispute.balance_transactions.filter((b) => b.amount < 0);
  const reinstated = dispute.balance_transactions.filter((b) => b.amount > 0);

  return json({
    dispute: {
      id: dispute.id,
      status: dispute.status,
      reason: dispute.reason,
      amount: dispute.amount,
      currency: dispute.currency,
      created: new Date(dispute.created * 1000).toISOString(),
      networkReasonCode: dispute.payment_method_details?.card?.network_reason_code ?? null,
      cardBrand: dispute.payment_method_details?.card?.brand ?? null,
      isInquiry: dispute.status.startsWith("warning_"),
      isChargeRefundable: dispute.is_charge_refundable,
      answerable: ANSWERABLE_STATUSES.has(dispute.status),
      dueBy: dispute.evidence_details?.due_by
        ? new Date(dispute.evidence_details.due_by * 1000).toISOString()
        : null,
      pastDue: Boolean(dispute.evidence_details?.past_due),
      hasEvidence: Boolean(dispute.evidence_details?.has_evidence),
      submissionCount: dispute.evidence_details?.submission_count ?? 0,
      money: {
        withdrawn: withdrawn.reduce((s, b) => s - b.amount, 0),
        fees: withdrawn.reduce((s, b) => s + b.fee, 0),
        reinstated: reinstated.reduce((s, b) => s + b.amount, 0),
        feesReturned: reinstated.reduce((s, b) => s - b.fee, 0),
      },
    },
    evidence: { text, files },
    prefill,
    facts: facts.join("\n"),
    payment: paymentSummary,
    booking: booking
      ? {
        id: booking.id,
        startsAt: booking.starts_at,
        checkedInAt: booking.checked_in_at,
        status: booking.voided_at ? "voided" : booking.status,
        tourName,
        businessName: booking.business?.name ?? null,
        guests,
        totalCents: booking.total_cents,
        ref,
        source,
      }
      : null,
    guest: booking?.customer
      ? { name: booking.customer.full_name, email: booking.customer.email, phone: booking.customer.phone }
      : null,
    transactionId: row.transaction_id,
    accountId: row.connected_account_id,
  });
}

// ── upload / file ────────────────────────────────────────────────────────────

async function upload(req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Send the file as a form upload." }, 400);
  }
  const row = await loadRow(String(form.get("dispute_id") ?? ""));
  if (!row) return json({ error: "Dispute not found." }, 404);

  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "Choose a file to upload." }, 400);
  if (!FILE_TYPES.has(file.type)) {
    return json({ error: "Use a PDF, PNG or JPEG file. Stripe takes no other kinds." }, 400);
  }
  if (file.size > MAX_FILE_BYTES) {
    return json({ error: "That file is over 4.5 MB, the most Stripe takes for a dispute." }, 400);
  }

  try {
    const uploaded = await uploadDisputeEvidenceFile(row.connected_account_id, file);
    return json({
      file: {
        id: uploaded.id,
        filename: uploaded.filename ?? file.name,
        size: uploaded.size ?? file.size,
        type: uploaded.type ?? file.type,
      },
    });
  } catch (err) {
    console.error("[stripe-disputes] upload failed:", err);
    return json({ error: stripeErrorMessage(err) }, 502);
  }
}

async function file(stripe: Stripe, row: DisputeRow, fileId: string): Promise<Response> {
  if (!FILE_ID_RE.test(fileId)) return json({ error: "file_id is required" }, 400);
  const opts = { stripeAccount: row.connected_account_id };
  try {
    // Only evidence files: never hand out an account's other documents.
    const meta = await stripe.files.retrieve(fileId, {}, opts);
    if (meta.purpose !== "dispute_evidence") return json({ error: "File not found." }, 404);
    const res = await downloadStripeFile(row.connected_account_id, fileId);
    if (!res.ok || !res.body) return json({ error: "Stripe did not send the file." }, 502);
    // Always raw bytes: supabase-js turns only octet-stream and PDF into a Blob and
    // would read an image as text. The screen knows the file's type already.
    return new Response(res.body, {
      headers: {
        ...corsHeaders,
        "content-type": "application/octet-stream",
        "content-disposition": `inline; filename="${(meta.filename ?? fileId).replace(/"/g, "")}"`,
      },
    });
  } catch (err) {
    console.error("[stripe-disputes] file read failed:", err);
    return json({ error: stripeErrorMessage(err) }, 502);
  }
}

// ── save / accept ────────────────────────────────────────────────────────────

/** Check the evidence the screen sent; returns Stripe's evidence object or an error. */
function cleanEvidence(input: unknown): { evidence: Record<string, string> } | { error: string } {
  if (!input || typeof input !== "object") return { error: "Nothing to save." };
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

async function save(
  stripe: Stripe,
  req: Request,
  staff: Staff,
  row: DisputeRow,
  input: unknown,
  submit: boolean,
): Promise<Response> {
  const cleaned = cleanEvidence(input);
  if ("error" in cleaned) return json({ error: cleaned.error }, 400);
  if (submit && !Object.values(cleaned.evidence).some((v) => v !== "")) {
    return json({ error: "Add an explanation or a document before sending it to the bank." }, 400);
  }

  const opts = { stripeAccount: row.connected_account_id };
  try {
    const current = await stripe.disputes.retrieve(row.stripe_dispute_id, {}, opts);
    if (!ANSWERABLE_STATUSES.has(current.status)) {
      return json({ error: "This dispute is no longer waiting for an answer. Reload to see where it stands." }, 409);
    }
    const updated = await stripe.disputes.update(
      row.stripe_dispute_id,
      { evidence: cleaned.evidence, submit, metadata: { pwc_last_saved_by: staff.id } },
      opts,
    );
    await upsertDisputes(db, [{ dispute: updated, accountId: row.connected_account_id, businessId: row.business_id }]);
    await logStaffAction(db, {
      staffId: staff.id,
      businessId: row.business_id,
      employee: await employeeFromRequest(db, req),
      entity: "stripe_disputes",
      entityId: row.stripe_dispute_id,
      action: submit ? "evidence_submitted" : "evidence_saved",
      changed: Object.keys(cleaned.evidence).filter((k) => cleaned.evidence[k] !== ""),
    });
    return json({ ok: true, status: updated.status });
  } catch (err) {
    console.error("[stripe-disputes] save failed:", err);
    return json({ error: stripeErrorMessage(err) }, 502);
  }
}

async function accept(stripe: Stripe, req: Request, staff: Staff, row: DisputeRow): Promise<Response> {
  const opts = { stripeAccount: row.connected_account_id };
  try {
    const current = await stripe.disputes.retrieve(row.stripe_dispute_id, {}, opts);
    if (!ANSWERABLE_STATUSES.has(current.status)) {
      return json({ error: "This dispute is no longer waiting for an answer. Reload to see where it stands." }, 409);
    }
    const closed = await stripe.disputes.close(row.stripe_dispute_id, {}, opts);
    await upsertDisputes(db, [{ dispute: closed, accountId: row.connected_account_id, businessId: row.business_id }]);
    await logStaffAction(db, {
      staffId: staff.id,
      businessId: row.business_id,
      employee: await employeeFromRequest(db, req),
      entity: "stripe_disputes",
      entityId: row.stripe_dispute_id,
      action: "accepted",
      payload: { amount_cents: closed.amount },
    });
    return json({ ok: true, status: closed.status });
  } catch (err) {
    console.error("[stripe-disputes] accept failed:", err);
    return json({ error: stripeErrorMessage(err) }, 502);
  }
}

// ── Entry ────────────────────────────────────────────────────────────────────

Deno.serve(withSentry("stripe-disputes", async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: BROWSER_PREFLIGHT_HEADERS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!stripeConfigured()) return json({ error: "Payments are not configured yet." }, 503);
  const stripe = getStripe()!;

  // An upload is a form; everything else is JSON with an `action`.
  const isUpload = (req.headers.get("content-type") ?? "").startsWith("multipart/form-data");
  let payload: { action?: Action; dispute_id?: string; file_id?: string; evidence?: unknown; submit?: boolean } = {};
  if (isUpload) {
    payload.action = "upload";
  } else {
    try {
      payload = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
  }
  const action = payload.action;

  if (action === "sync" && isServiceRoleToken(req)) return await sync(stripe);

  const auth = await requireStaff(req);
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  if (auth.staff.role !== "owner") return json({ error: "Not authorized." }, 403);

  if (action === "sync") return await sync(stripe);
  if (action === "upload") return await upload(req);

  const row = await loadRow((payload.dispute_id ?? "").trim());
  if (!row) return json({ error: "Dispute not found." }, 404);

  switch (action) {
    case "detail":
      return await detail(stripe, row);
    case "file":
      return await file(stripe, row, (payload.file_id ?? "").trim());
    case "save":
      return await save(stripe, req, auth.staff, row, payload.evidence, payload.submit === true);
    case "accept":
      return await accept(stripe, req, auth.staff, row);
    default:
      return json({ error: "Unknown action" }, 400);
  }
}));
