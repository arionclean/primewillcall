// The whole dispute answer, against Stripe's TEST mode: a disputed payment on a
// connected account, an evidence file uploaded to that account, a draft saved,
// fields cleared, the file read back, the answer submitted once (and a second
// submission refused by Stripe), and a dispute accepted. It uses the same helpers
// and the same update parameters as the stripe-disputes function.
//
// Opt-in, and test mode only: it refuses to run unless the key is a test key.
//   STRIPE_SECRET_KEY=<sk_test_ or rk_test_ key> STRIPE_SANDBOX_ACCOUNT=acct_... \
//   deno test --node-modules-dir=none --allow-env --allow-net --allow-read \
//     supabase/functions/_shared/dispute-evidence.sandbox.test.ts
// The account must be a TEST connected account of the platform with charges on.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import type Stripe from "npm:stripe@22.3.0";

import { cleanEvidence, evidenceUpdate } from "./dispute-evidence.ts";
import { downloadStripeFile, getStripe, uploadDisputeEvidenceFile } from "./stripe.ts";

const KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const ACCOUNT = Deno.env.get("STRIPE_SANDBOX_ACCOUNT") ?? "";
const ENABLED = /^(sk|rk)_test_/.test(KEY) && /^acct_/.test(ACCOUNT);

const opts = { stripeAccount: ACCOUNT };

/** A valid one-page PDF, built with correct byte offsets so Stripe accepts it. */
function tinyPdf(): Uint8Array<ArrayBuffer> {
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<<>>>>",
    "<</Length 0>>\nstream\n\nendstream",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

const PDF = tinyPdf();

function cleaned(input: Record<string, string>): Record<string, string> {
  const result = cleanEvidence(input);
  if ("error" in result) throw new Error(result.error);
  return result.evidence;
}

/** A card payment on the connected account that the test card turns into a dispute. */
async function disputedPayment(stripe: Stripe, paymentMethod: string): Promise<Stripe.Dispute> {
  const pi = await stripe.paymentIntents.create(
    {
      amount: 5350,
      currency: "usd",
      payment_method: paymentMethod,
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      description: "PrimeWillCall dispute sandbox test",
    },
    opts,
  );
  for (let i = 0; i < 30; i++) {
    const { data } = await stripe.disputes.list({ payment_intent: pi.id, limit: 1 }, opts);
    if (data[0]) return data[0];
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`No dispute appeared for ${pi.id}`);
}

async function waitForStatus(stripe: Stripe, id: string, statuses: string[], seconds: number): Promise<Stripe.Dispute> {
  let dispute = await stripe.disputes.retrieve(id, {}, opts);
  for (let i = 0; i < seconds / 3 && !statuses.includes(dispute.status); i++) {
    await new Promise((r) => setTimeout(r, 3000));
    dispute = await stripe.disputes.retrieve(id, {}, opts);
  }
  return dispute;
}

Deno.test({
  name: "sandbox: draft, clear, read back, submit once",
  ignore: !ENABLED,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    assert(/^(sk|rk)_test_/.test(KEY), "refusing to run without a TEST key");
    const stripe = getStripe()!;
    const dispute = await disputedPayment(stripe, "pm_card_createDispute");
    assertEquals(dispute.status, "needs_response");
    let fileId = "";

    await t.step("an evidence file uploads to the connected account", async () => {
      const file = await uploadDisputeEvidenceFile(ACCOUNT, new File([PDF], "receipt.pdf", { type: "application/pdf" }));
      assert(/^file_/.test(file.id));
      assertEquals(file.purpose, "dispute_evidence");
      fileId = file.id;
    });

    await t.step("a draft is stored and NOT sent to the bank", async () => {
      const updated = await stripe.disputes.update(
        dispute.id,
        evidenceUpdate(cleaned({ uncategorized_text: "  Draft explanation  ", product_description: "Sunset cruise", receipt: fileId }), false, "sandbox"),
        opts,
      );
      assertEquals(updated.status, "needs_response");
      assertEquals(updated.evidence_details.submission_count, 0);
      assertEquals(updated.evidence.uncategorized_text, "Draft explanation");
      assertEquals(updated.evidence.receipt, fileId);
      assertEquals(updated.metadata.pwc_last_saved_by, "sandbox");
    });

    await t.step("an empty field clears it, the rest stays", async () => {
      const updated = await stripe.disputes.update(
        dispute.id,
        evidenceUpdate(cleaned({ product_description: "", receipt: "" }), false, "sandbox"),
        opts,
      );
      assert(!updated.evidence.product_description, "product_description should be cleared");
      assert(!updated.evidence.receipt, "receipt should be cleared");
      assertEquals(updated.evidence.uncategorized_text, "Draft explanation");
      assertEquals(updated.status, "needs_response");
    });

    await t.step("the uploaded file reads back byte for byte", async () => {
      const res = await downloadStripeFile(ACCOUNT, fileId);
      assert(res.ok, `download answered ${res.status}`);
      assertEquals(new Uint8Array(await res.arrayBuffer()), PDF);
    });

    await t.step("the submission goes to the bank once", async () => {
      // "winning_evidence" is Stripe's test trigger for a dispute the bank decides for us.
      const submitted = await stripe.disputes.update(
        dispute.id,
        evidenceUpdate(cleaned({ uncategorized_text: "winning_evidence", receipt: fileId }), true, "sandbox"),
        opts,
      );
      assertEquals(submitted.evidence_details.submission_count, 1);
      assert(["under_review", "won"].includes(submitted.status), `status ${submitted.status}`);
    });

    await t.step("Stripe refuses a second submission", async () => {
      await assertRejects(() =>
        stripe.disputes.update(dispute.id, evidenceUpdate(cleaned({ uncategorized_text: "again" }), true, "sandbox"), opts)
      );
    });

    await t.step("the bank decides it (test mode)", async () => {
      const final = await waitForStatus(stripe, dispute.id, ["won"], 60);
      assert(["under_review", "won"].includes(final.status), `status ${final.status}`);
      console.log(`  final status: ${final.status}`);
    });
  },
});

Deno.test({
  name: "sandbox: accepting a dispute closes it as lost",
  ignore: !ENABLED,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    assert(/^(sk|rk)_test_/.test(KEY), "refusing to run without a TEST key");
    const stripe = getStripe()!;
    const dispute = await disputedPayment(stripe, "pm_card_createDispute");
    const closed = await stripe.disputes.close(dispute.id, {}, opts);
    assertEquals(closed.status, "lost");
    await assertRejects(() =>
      stripe.disputes.update(dispute.id, evidenceUpdate(cleaned({ uncategorized_text: "late" }), true, "sandbox"), opts)
    );
  },
});

Deno.test({
  name: "sandbox: an inquiry takes a draft, and a refund closes it",
  ignore: !ENABLED,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    assert(/^(sk|rk)_test_/.test(KEY), "refusing to run without a TEST key");
    const stripe = getStripe()!;
    const dispute = await disputedPayment(stripe, "pm_card_createDisputeInquiry");
    assertEquals(dispute.status, "warning_needs_response");
    assertEquals(dispute.is_charge_refundable, true);
    const updated = await stripe.disputes.update(
      dispute.id,
      evidenceUpdate(cleaned({ uncategorized_text: "Inquiry draft" }), false, "sandbox"),
      opts,
    );
    assertEquals(updated.status, "warning_needs_response");
    // Closing an inquiry is a no-op on Stripe (checked here 2026-10-06: it stays
    // warning_needs_response), so the screen never offers it. A refund is the way
    // out, the same refund the payments function makes.
    const charge = typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id;
    const refund = await stripe.refunds.create({ charge }, opts);
    assert(["succeeded", "pending"].includes(refund.status ?? ""), `refund ${refund.status}`);
    const settled = await waitForStatus(stripe, dispute.id, ["warning_closed", "charge_refunded"], 45);
    console.log(`  inquiry after a refund: ${settled.status}`);
    assert(["warning_closed", "charge_refunded"].includes(settled.status), `status ${settled.status}`);
  },
});
