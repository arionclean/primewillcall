// Run: deno test --node-modules-dir=none supabase/functions/_shared/dispute-evidence.test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";

import {
  cleanEvidence,
  evidenceUpdate,
  FILE_FIELDS,
  hasEvidence,
  MAX_TEXT_FIELD,
  TEXT_FIELDS,
} from "./dispute-evidence.ts";

Deno.test("a draft says submit: false, a submission says submit: true", () => {
  // Stripe's default for `submit` is true. A draft that left it out would go to
  // the bank, so the key must be present either way.
  const draft = evidenceUpdate({ uncategorized_text: "x" }, false, "staff-1");
  assert("submit" in draft);
  assertEquals(draft.submit, false);
  assertEquals(evidenceUpdate({ uncategorized_text: "x" }, true, "staff-1").submit, true);
});

Deno.test("text is trimmed and an empty field is sent as empty (clears it on Stripe)", () => {
  const cleaned = cleanEvidence({ uncategorized_text: "  hello \n", customer_name: "   ", receipt: "" });
  assert("evidence" in cleaned);
  assertEquals(cleaned.evidence, { uncategorized_text: "hello", customer_name: "", receipt: "" });
});

Deno.test("only known fields are accepted", () => {
  assert("error" in cleanEvidence({ shipping_address: "1 Main St" }));
  assert("error" in cleanEvidence({ enhanced_evidence: "x" }));
  assert("error" in cleanEvidence({ uncategorized_text: 5 }));
  assert("error" in cleanEvidence(null));
  assert("error" in cleanEvidence(["uncategorized_text"]));
});

Deno.test("file fields take a Stripe file id or nothing", () => {
  assert("evidence" in cleanEvidence({ receipt: "file_1AbC" }));
  assert("error" in cleanEvidence({ receipt: "https://example.com/receipt.pdf" }));
  assert("error" in cleanEvidence({ receipt: "file_1AbC; drop" }));
});

Deno.test("Stripe's text limits are enforced before calling Stripe", () => {
  assert("error" in cleanEvidence({ uncategorized_text: "a".repeat(MAX_TEXT_FIELD + 1) }));
  assert("evidence" in cleanEvidence({ uncategorized_text: "a".repeat(MAX_TEXT_FIELD) }));
  // 8 fields of 19,000 characters each is 152,000: over the 150,000 total.
  const tooMuch = Object.fromEntries(TEXT_FIELDS.slice(0, 8).map((f) => [f, "a".repeat(19_000)]));
  assert("error" in cleanEvidence(tooMuch));
});

Deno.test("nothing to send means nothing to submit", () => {
  assertEquals(hasEvidence({ uncategorized_text: "", receipt: "" }), false);
  assertEquals(hasEvidence({ uncategorized_text: "", receipt: "file_1" }), true);
});

Deno.test("the screen's field list matches the server's", async () => {
  // The form (src/lib/payments/disputes.ts) sends every field it lists on every
  // save. A field the server does not know would be refused; a field the form
  // forgot would never reach Stripe. Read its keys straight from the source.
  const source = await Deno.readTextFile(
    new URL("../../../src/lib/payments/disputes.ts", import.meta.url),
  );
  const block = source.slice(source.indexOf("export const EVIDENCE_FIELDS"), source.indexOf("export const TEXT_FIELD_KEYS"));
  const keys = (kind: "text" | "file") =>
    [...block.matchAll(/key: "([a-z_]+)",\s*kind: "(text|file)"/g)].filter((m) => m[2] === kind).map((m) => m[1]).sort();
  assertEquals(keys("text"), [...TEXT_FIELDS].sort());
  assertEquals(keys("file"), [...FILE_FIELDS].sort());
});
