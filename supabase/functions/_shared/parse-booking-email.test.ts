import { assertEquals } from "jsr:@std/assert@1";
import { parseBookingEmail } from "./parse-booking-email.ts";

// A real Bokun supplier-notification email (Viator booking via TripAdvisor).
const REAL = {
  text:
    "The following booking was just created.  Booking ref. VIA-94036670 Product booking ref. 4TH-T133696602 [https://miamiskylinecruises.bokun.io/bookings/activity/133696602] Ext. booking ref 1408575445 Product 423335P7 - Miami City Tour and Boat Tour - Land & Sea Combo Supplier Miami Skyline Cruises Sold by Viator.com Booking channel Viator.com Customer Borda, MaryBeth Customer email S-9f6f1626f2d94dba8f67e4d4e95bcde6+1408575445-14xi7e1pc6ira@expmessaging.tripadvisor.com Customer phone US+1 (414) 708-7727 Date Thu 18.Jun '26 @ 09:30 Rate Miami City Tour and Boat Tour - Land & Sea Combo PAX 3 Adult 1 Child Guided languages (Guided language: English) Extras Created Tue, June 09 2026 @ 16:41 Notes --- Inclusions: --- Air-conditioned vehicle  --- Booking languages: --- GUIDE : English Viator amount: USD 90.31  Want $50 in Bokun credit?",
  company: "1712894857551x926333421634977800",
  subject:
    "New booking: Thu 18.Jun '26 @ 09:30 (4TH-T133696602) Ext. booking ref: 1408575445",
};

Deno.test("parses the real Bokun/Viator notification", () => {
  const r = parseBookingEmail(REAL);
  console.log("PARSED =>", JSON.stringify(r, null, 2));

  assertEquals(r.bookingReference, "4TH-T133696602"); // Product booking ref
  assertEquals(r.bookingRef, "VIA-94036670");
  assertEquals(r.extBookingRef, "1408575445");
  assertEquals(r.productCode, "423335P7");
  assertEquals(
    r.productName,
    "Miami City Tour and Boat Tour - Land & Sea Combo",
  );
  assertEquals(r.supplier, "Miami Skyline Cruises");
  assertEquals(r.soldBy, "Viator.com");
  assertEquals(r.bookingChannel, "Viator.com");
  assertEquals(r.customerName, "MaryBeth Borda");
  assertEquals(r.Fname, "MaryBeth");
  assertEquals(r.Lname, "Borda");
  assertEquals(
    r.email,
    "S-9f6f1626f2d94dba8f67e4d4e95bcde6+1408575445-14xi7e1pc6ira@expmessaging.tripadvisor.com",
  );
  assertEquals(r.correctEmail, true);
  assertEquals(r.phone, "14147087727");
  assertEquals(r.adult, 3); // "3 Adult"
  assertEquals(r.child, 1);
  assertEquals(r.infant, 0);
  assertEquals(r.paxs, 4); // 3 adult + 1 child, consistent with the $90.31 net
  assertEquals(r.paxTotal, null); // "PAX" is a header here, not a total
  assertEquals(r.diagnostics.paxMismatch, false);
  assertEquals(r.status, "confirmed");
  assertEquals(r.startsAtUtc, "2026-06-18T13:30:00.000Z"); // 09:30 EDT -> 13:30 UTC
  assertEquals(r.totalCents, 9031);
  assertEquals(r.currency, "usd");
});

Deno.test("status maps from the subject", () => {
  assertEquals(parseBookingEmail({ ...REAL, subject: "Cancelled booking: x" }).status, "cancelled");
  assertEquals(parseBookingEmail({ ...REAL, subject: "Updated booking: x" }).status, "confirmed");
});
