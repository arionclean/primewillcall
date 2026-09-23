import { assertEquals } from "jsr:@std/assert@1";
import { companyFor, looksLikeBooking, warningsFor } from "./inbound-email.ts";
import { parseBookingEmail } from "./parse-booking-email.ts";

// The Mailroom's two judgement calls: is an email that read as nothing still a
// booking (then a person must look), and what did a booking it made come without.

Deno.test("an empty read of a real Bokun email is a booking, not junk", () => {
  // Labels present, values unreadable: the shape of the first real forward, which
  // was filed as "not a booking" before the parser learned to strip the asterisks.
  const text =
    "*Booking ref.* *Product booking ref.* *Booking channel* *Customer email* ...";
  assertEquals(looksLikeBooking(null, text), true);
});

Deno.test("a subject that names a booking is enough", () => {
  assertEquals(looksLikeBooking("New booking: Thu 18.Jun '26 @ 09:30", "..."), true);
  assertEquals(looksLikeBooking("Cancelled booking: 4TH-T133696602", "..."), true);
  assertEquals(looksLikeBooking("Reservation confirmed", ""), true);
});

Deno.test("mail that is not a reservation stays quiet", () => {
  // The one non-booking in the first 66 emails.
  assertEquals(
    looksLikeBooking(
      "(#123) Gmail Forwarding Confirmation - Receive Mail from reservations369@gmail.com",
      "reservations369@gmail.com has requested to automatically forward mail to your " +
        "email address. To allow this, click the link below.",
    ),
    false,
  );
  assertEquals(looksLikeBooking("Your weekly Bokun newsletter", "Tips for suppliers"), false);
});

Deno.test("a complete read has no warnings", () => {
  const b = parseBookingEmail({
    text:
      "Booking ref. VIA-1 Product booking ref. 4TH-T1 Product 423335P7 - Miami City Tour Supplier Miami Skyline Cruises Sold by Viator.com Booking channel Viator.com Customer Borda, MaryBeth Customer email a@b.com Customer phone US+1 (414) 708-7727 Date Thu 18.Jun '26 @ 09:30 Rate Combo PAX 3 Adult 1 Child",
    subject: "New booking",
  });
  assertEquals(warningsFor(b as unknown as Record<string, unknown>), []);
});

Deno.test("a missing head count and a missing name are named, head count first", () => {
  assertEquals(
    warningsFor({ adult: 0, child: 0, infant: 0, bookingChannel: "Viator.com" }),
    ["no_guest_count", "no_guest_name"],
  );
});

Deno.test("a head count that disagrees with the email's total is flagged", () => {
  assertEquals(
    warningsFor({
      adult: 2,
      child: 0,
      infant: 0,
      customerName: "MaryBeth Borda",
      bookingChannel: "Viator.com",
      diagnostics: { paxMismatch: true },
    }),
    ["guest_count_mismatch"],
  );
});

Deno.test("the business decision still reads only the first two To: addresses", () => {
  assertEquals(
    companyFor(["someone@else.com", "reservations@keywestsightseeingtours.com"]),
    "1712896100693x988159247184035800",
  );
  assertEquals(
    companyFor(["a@x.com", "b@x.com", "reservations@keywestsightseeingtours.com"]),
    "1712894857551x926333421634977800",
  );
});
