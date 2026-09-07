// deno test supabase/functions/_shared/kiosk-sale.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import {
  canReuseSale,
  computeApplicationFeeCents,
  normalizeFirstName,
  parseXanoDateTime,
  startsAtFromXanoDateTime,
} from "./kiosk-sale.ts";

Deno.test("parseXanoDateTime reads the tablet's date_time strings", () => {
  assertEquals(parseXanoDateTime("Sep 7 2026 10:30 AM"), { date: "2026-09-07", time: "10:30" });
  assertEquals(parseXanoDateTime("Dec 12 2025 7:00 PM"), { date: "2025-12-12", time: "19:00" });
  assertEquals(parseXanoDateTime("Jan 3 2027 12:15 AM"), { date: "2027-01-03", time: "00:15" });
  assertEquals(parseXanoDateTime("Jun 30 2026 12:00 PM"), { date: "2026-06-30", time: "12:00" });
  assertEquals(parseXanoDateTime("Sep 7 2026"), { date: "2026-09-07", time: null });
  assertEquals(parseXanoDateTime("garbage"), null);
  assertEquals(parseXanoDateTime(""), null);
});

Deno.test("startsAtFromXanoDateTime converts New York wall clock to UTC, DST-correct", () => {
  assertEquals(startsAtFromXanoDateTime("Sep 7 2026 10:30 AM"), "2026-09-07T14:30:00.000Z"); // EDT, UTC-4
  assertEquals(startsAtFromXanoDateTime("Jan 15 2027 10:30 AM"), "2027-01-15T15:30:00.000Z"); // EST, UTC-5
  assertEquals(startsAtFromXanoDateTime("Sep 7 2026"), "2026-09-07T12:00:00.000Z"); // date only, like the sync
  assertEquals(startsAtFromXanoDateTime("nope"), null);
});

Deno.test("normalizeFirstName keeps only the first word, lower-cased, letters and digits", () => {
  assertEquals(normalizeFirstName("Rachelle A. Moscozo"), "rachelle");
  assertEquals(normalizeFirstName("  rafael "), "rafael");
  assertEquals(normalizeFirstName("O'Brien"), "obrien");
  assertEquals(normalizeFirstName(null), "");
});

Deno.test("computeApplicationFeeCents matches kiosk-payment-intent", () => {
  assertEquals(computeApplicationFeeCents(8025), 20); // 0.25% floored
  assertEquals(computeApplicationFeeCents(100), 0);
  assertEquals(computeApplicationFeeCents(1), 0);
});

const CREATED = "2026-09-04T22:11:12Z";
const t = (secondsLater: number) => Date.parse(CREATED) + secondsLater * 1000;
const base = {
  amount_cents: 8025,
  customer_name: "Rafael",
  tablet_acked_at: null,
  status: "paid",
  created_at: CREATED,
};

Deno.test("canReuseSale: under two minutes, the same amount on an unacknowledged captured payment is enough", () => {
  assertEquals(canReuseSale(base, { amountCents: 8025, customerName: "Rafael" }, t(48)), true);
  assertEquals(canReuseSale(base, { amountCents: 8025, customerName: "Michelle" }, t(48)), true); // typo-tolerant window
  assertEquals(canReuseSale(base, { amountCents: 5350, customerName: "Rafael" }, t(48)), false); // different amount, never
});

Deno.test("canReuseSale: two to five minutes needs the first name, prefix tolerant", () => {
  assertEquals(canReuseSale(base, { amountCents: 8025, customerName: "rafael perez" }, t(180)), true);
  assertEquals(canReuseSale({ ...base, customer_name: "Rachelle Moscozo" }, { amountCents: 8025, customerName: "Rachel" }, t(180)), true);
  assertEquals(canReuseSale({ ...base, customer_name: "Rachel" }, { amountCents: 8025, customerName: "Rachelle" }, t(180)), true);
  assertEquals(canReuseSale(base, { amountCents: 8025, customerName: "Michelle" }, t(180)), false);
  assertEquals(canReuseSale(base, { amountCents: 8025, customerName: "Ra" }, t(180)), false); // too short to trust
});

Deno.test("canReuseSale: a sale with no real name is reused on amount alone inside five minutes", () => {
  assertEquals(canReuseSale({ ...base, customer_name: "Walk-in" }, { amountCents: 8025, customerName: "Ana" }, t(200)), true);
  assertEquals(canReuseSale({ ...base, customer_name: null }, { amountCents: 8025, customerName: "Ana" }, t(200)), true);
});

Deno.test("canReuseSale: never for an acknowledged, old, pending or abandoned sale", () => {
  assertEquals(canReuseSale({ ...base, tablet_acked_at: "2026-09-04T22:11:30Z" }, { amountCents: 8025, customerName: "Rafael" }, t(48)), false);
  assertEquals(canReuseSale(base, { amountCents: 8025, customerName: "Rafael" }, t(6 * 60)), false);
  assertEquals(canReuseSale(base, { amountCents: 8025, customerName: "Rafael" }, t(-5)), false);
  assertEquals(canReuseSale({ ...base, status: "pending" }, { amountCents: 8025, customerName: "Rafael" }, t(48)), false);
  assertEquals(canReuseSale({ ...base, status: "abandoned" }, { amountCents: 8025, customerName: "Rafael" }, t(48)), false);
});
