// The Xano mirror's payloads. Every rule here is one Xano depends on: no phone (its
// SMS trigger), the product fallback (its day list), the status spelling, the two
// time fields. Run: deno test supabase/functions/_shared/xano-mirror.test.ts

import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import {
  buildCreatePayload,
  buildUpdatePayload,
  knownXanoId,
  mirrorRef,
  type MirrorBooking,
  probableInternalId,
  retryDelaySeconds,
  unmirrorableReason,
} from "./xano-mirror.ts";

function booking(over: Partial<MirrorBooking> = {}): MirrorBooking {
  return {
    id: "b1",
    status: "confirmed",
    // 2026-09-08 14:30 New York (EDT) = 18:30Z
    starts_at: "2026-09-08T18:30:00.000Z",
    pax_adult: 2,
    pax_child: 1,
    pax_infant: 1,
    notes: "Window seat",
    checked_in_at: null,
    legacy_id: null,
    legacy_reference: null,
    source_channel: "Phone reservation",
    public_token: "tok123",
    due_cents: 0,
    xano_internal_id: null,
    xano_booking_id: null,
    customer: { full_name: "Ada Mary Lovelace" },
    business_tour: {
      name: "Everglades Tour",
      legacy_product_id: null,
      tour: { legacy_product_id: "1773434727387x309844007274755000" },
      business: { name: "Key West Sightseeing Tours", legacy_company_id: "1712896100693x988159247184035800" },
    },
    ...over,
  };
}

Deno.test("create: no phone, no email, trigger off, our token as the confirmation id", () => {
  const p = buildCreatePayload(booking(), "SB-ABC");
  assertEquals(p.phone, "null");
  assertEquals(p.email, "");
  assertEquals(p.trigger, false);
  assertEquals(p.bookingConfirmation_id, "tok123");
  assertEquals(p.internal_id, "SB-ABC");
  assertEquals(p.booking_reference, "SB-ABC");
  assertEquals(p.booking_channel, "Phone reservation");
});

Deno.test("create: the master tour's Xano product when the business has no copy", () => {
  const p = buildCreatePayload(booking(), "SB-ABC");
  assertEquals(p.product, "1773434727387x309844007274755000");
  assertEquals(p.company, "1712896100693x988159247184035800");
  assertEquals(p.product_var, "Everglades Tour");
  assertEquals(p.supplier, "Key West Sightseeing Tours");
});

Deno.test("create: name split Bubble's way, pax and the two time fields", () => {
  const p = buildCreatePayload(booking(), "SB-ABC");
  assertEquals(p.Fname, "Ada");
  assertEquals(p.Lname, "Mary Lovelace");
  assertEquals(p.customer_name, "Mary Lovelace, Ada");
  assertEquals(p.adult, 2);
  assertEquals(p.child, 1);
  assertEquals(p.infant, 1);
  assertEquals(p.paxs, 3);
  assertEquals(p.date, "2026-09-08");
  assertEquals(p.date_timestamp, Date.parse("2026-09-08T18:30:00.000Z"));
  assertEquals(p.status, "confirmed");
  assertEquals(p.checked, false);
  assertEquals(p.note, "Window seat");
});

Deno.test("create: a reference the desk typed wins over our own", () => {
  const p = buildCreatePayload(booking({ legacy_reference: " 4TH-T1234 " }), "SB-ABC");
  assertEquals(p.booking_reference, "4TH-T1234");
});

Deno.test("create: cancelled is spelled Xano's way, check-in carries its time", () => {
  const p = buildCreatePayload(
    booking({ status: "cancelled", checked_in_at: "2026-09-08T18:00:00.000Z" }),
    "SB-ABC",
  );
  assertEquals(p.status, "canceled");
  assertEquals(p.checked, true);
  assertEquals(p.check_in_time, Date.parse("2026-09-08T18:00:00.000Z"));
});

Deno.test("update: only the changed fields, nothing Xano owns", () => {
  const u = buildUpdatePayload(booking({ pax_adult: 3 }), ["pax"]);
  assertEquals(u, { adult: 3, child: 1, infant: 1, paxs: 4 });
});

Deno.test("update: a new time is the two stored fields, never date_time", () => {
  const u = buildUpdatePayload(booking(), ["starts_at"]);
  assertEquals(u, { date_timestamp: Date.parse("2026-09-08T18:30:00.000Z"), date: "2026-09-08" });
});

Deno.test("update: un-check clears the time, a void is canceled, a note can go null", () => {
  const u = buildUpdatePayload(
    booking({ status: "cancelled", checked_in_at: null, notes: null }),
    ["status", "checked_in_at", "notes"],
  );
  assertEquals(u, { status: "canceled", checked: false, check_in_time: null, note: null });
});

Deno.test("update: a product change re-sends the four product fields", () => {
  const u = buildUpdatePayload(booking(), ["business_tour_id"]);
  assertEquals(u.product, "1773434727387x309844007274755000");
  assertEquals(u.product_var, "Everglades Tour");
  assertEquals(u.supplier, "Key West Sightseeing Tours");
  assertEquals(u.company, "1712896100693x988159247184035800");
});

Deno.test("unmirrorable: no Xano company, no Xano product", () => {
  assertEquals(unmirrorableReason(booking()), null);
  assertMatch(
    unmirrorableReason(booking({
      business_tour: { name: "Jet Ski", legacy_product_id: null, tour: null, business: { name: "Miami Jet Ski Tours", legacy_company_id: null } },
    })) ?? "",
    /not linked to a Xano company/,
  );
  assertMatch(
    unmirrorableReason(booking({
      business_tour: { name: "New Tour", legacy_product_id: null, tour: { legacy_product_id: null }, business: { name: "X", legacy_company_id: "c" } },
    })) ?? "",
    /not linked to a Xano product/,
  );
});

Deno.test("where the Xano row is: stored id, xano-<id> legacy id, or an internal id", () => {
  assertEquals(knownXanoId(booking({ xano_booking_id: 42 })), 42);
  assertEquals(knownXanoId(booking({ legacy_id: "xano-77" })), 77);
  assertEquals(knownXanoId(booking({ legacy_id: "ota-4TH-1" })), null);
  assertEquals(probableInternalId(booking({ xano_internal_id: "SB-1" })), "SB-1");
  assertEquals(probableInternalId(booking({ legacy_id: "KS-ABC" })), "KS-ABC");
  assertEquals(probableInternalId(booking({ legacy_id: "ota-4TH-1" })), null);
  assertEquals(probableInternalId(booking({ legacy_id: "xano-77" })), null);
});

Deno.test("refs and backoff", () => {
  assertMatch(mirrorRef(), /^SB-[0-9A-F]{16}$/);
  assertEquals(retryDelaySeconds(1), 60);
  assertEquals(retryDelaySeconds(2), 120);
  assertEquals(retryDelaySeconds(4), 480);
  assertEquals(retryDelaySeconds(20), 3600);
});
