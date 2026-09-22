// The kiosk tablet's `date_time` is a New York wall clock. These cases are the ones
// that would silently book a guest on the wrong hour or the wrong day if the string
// were read as UTC, so they are the ones worth pinning.
import { assertEquals } from "jsr:@std/assert@1";
import { nyDisplayToUtcIso } from "./ny-time.ts";

Deno.test("the ticket that started this: Sep 22 2026 11:30 AM -> 15:30Z", () => {
  assertEquals(nyDisplayToUtcIso("Sep 22 2026 11:30 AM"), "2026-09-22T15:30:00.000Z");
});

Deno.test("summer (EDT, -4) and winter (EST, -5) use the real offset", () => {
  assertEquals(nyDisplayToUtcIso("Jul 4 2026 9:00 AM"), "2026-07-04T13:00:00.000Z");
  assertEquals(nyDisplayToUtcIso("Jan 6 2027 9:00 AM"), "2027-01-06T14:00:00.000Z");
});

Deno.test("noon and midnight do not flip", () => {
  assertEquals(nyDisplayToUtcIso("Sep 22 2026 12:00 PM"), "2026-09-22T16:00:00.000Z");
  // Midnight NY is the next UTC day: the day must roll, not the hour alone.
  assertEquals(nyDisplayToUtcIso("Sep 22 2026 12:00 AM"), "2026-09-22T04:00:00.000Z");
});

Deno.test("an evening departure keeps its own NY day", () => {
  // 8 PM NY is 00:00Z the NEXT day. Reading the string as UTC would have put this
  // guest on the 22nd at 8 PM UTC, which is 4 PM on the manifest.
  assertEquals(nyDisplayToUtcIso("Sep 22 2026 8:00 PM"), "2026-09-23T00:00:00.000Z");
});

Deno.test("the shapes the tablet can print", () => {
  assertEquals(nyDisplayToUtcIso("Sep 2 2026 9:05 AM"), "2026-09-02T13:05:00.000Z"); // no zero pad
  assertEquals(nyDisplayToUtcIso("  Sep 22 2026 11:30 AM  "), "2026-09-22T15:30:00.000Z");
  assertEquals(nyDisplayToUtcIso("September 22, 2026, 11:30 AM"), "2026-09-22T15:30:00.000Z");
  assertEquals(nyDisplayToUtcIso("sep 22 2026 11:30 pm"), "2026-09-23T03:30:00.000Z");
});

Deno.test("no time on the ticket: the date, with the same placeholder a bare date gets", () => {
  assertEquals(nyDisplayToUtcIso("Sep 22 2026"), "2026-09-22T12:00:00.000Z");
});

Deno.test("nonsense is refused rather than guessed", () => {
  for (const bad of ["", "tomorrow", "2026-09-22", "Xyz 22 2026 11:30 AM", "Sep 22 2026 13:30 AM", "Sep 40 2026", "Sep 22 2026 11:70 AM"]) {
    assertEquals(nyDisplayToUtcIso(bad), null, bad);
  }
});
