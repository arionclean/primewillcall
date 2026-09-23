import { assertEquals } from "jsr:@std/assert@1";
import { classifyPhone, storablePhone } from "./phone.ts";

// Every shape a US number arrived in across the first 89 Mailroom emails. None of
// them may change: these are the guests who get the booking texts.
const US = [
  ["+1 3055551234", "13055551234"],
  ["+13055551234", "13055551234"],
  ["US+1 (414) 708-7727", "14147087727"],
  ["US+1 4147087727", "14147087727"],
  ["PR+1 7875551234", "17875551234"],
  ["(305) 555-1234", "3055551234"],
  ["3055551234", "3055551234"],
];

Deno.test("a US number stores as digits, exactly as before", () => {
  for (const [raw, stored] of US) {
    assertEquals(storablePhone(raw), stored, raw);
    assertEquals(classifyPhone(storablePhone(raw))?.isUs, true, raw);
  }
});

Deno.test("a foreign number keeps its plus", () => {
  assertEquals(storablePhone("+393408501316"), "+393408501316");
  assertEquals(storablePhone("+34 612345678"), "+34612345678");
  assertEquals(storablePhone("ES+34 612 34 56 78"), "+34612345678");
  assertEquals(storablePhone("GB+44 7700900123"), "+447700900123");
});

Deno.test("a ten-digit foreign number is not read as a US one", () => {
  // Norway, Denmark and Singapore numbers are ten digits with the country code.
  // Without the plus they read as US numbers, and the texts meant for the guest
  // would go to whoever holds that US number.
  assertEquals(classifyPhone("4791234567")?.isUs, true);
  for (const raw of ["+47 912 34 567", "+45 20 12 34 56", "+65 8123 4567"]) {
    assertEquals(classifyPhone(storablePhone(raw))?.isUs, false, raw);
  }
});

Deno.test("nothing to store", () => {
  assertEquals(storablePhone(null), null);
  assertEquals(storablePhone(""), null);
  assertEquals(storablePhone("N/A"), null);
  assertEquals(storablePhone("+"), null);
});
