// Replays real voucher OCR text through the deterministic matcher. Every case here
// is a voucher that either booked the wrong product in production or guards a rule
// that an earlier fix depended on. Run: deno test supabase/functions/_shared/gp-match.test.ts

import { assertEquals } from "jsr:@std/assert@1";
import { type Candidate, deterministicMatch } from "./gp-match.ts";

const SKYLINE = {
  business_id: "b-skyline",
  business_name: "Miami Skyline Cruises",
  merchant_names: ["Miami Skyline Cruises", "Miami Star Island Cruises", "Miami Tour Bus"],
};
const KEY_WEST = {
  business_id: "b-keywest",
  business_name: "Key West Sightseeing Tours",
  merchant_names: ["Key West Sightseeing Tours"],
};

function product(
  biz: typeof SKYLINE,
  name: string,
  aliases: string[] = [],
  fee = 499,
): Candidate {
  return {
    ...biz,
    business_tour_id: `bt-${name}`,
    tour_id: `t-${name}`,
    tour_name: name,
    product_name: name,
    groupon_fee_cents: fee,
    aliases: [name, ...aliases],
  };
}

// A cut of the live catalog (groupon_candidates() on 2026-09-04), in the order
// Postgres returned it that day, which put Transportation after Everglades Tour.
const CATALOG: Candidate[] = [
  product(KEY_WEST, "Key West Day Trips", [
    "Key West Day Trip from Miami: A Day in Paradise",
    "Miami to Key West Bus Tour",
  ]),
  product(SKYLINE, "Everglades Tour", [
    "Everglades Tour from Miami | Airboat & Alligator Show",
    "Everglades Airboat Tour with Round Trip Transportation",
    "Everglades Tour with Transportation from Miami",
  ]),
  product(SKYLINE, "Jet Ski", ["Miami Guided Jet Ski Tours | Biscayne Bay Adventure"], 0),
  product(SKYLINE, "Miami 5 in 1 City Tour", [
    "Miami City Tours - 5 Sites, 4 Stops, One Tour - 3.5 Hours of Fun",
    "Miami Skyline City Tour",
  ]),
  product(SKYLINE, "Miami City Tour combo", [
    "Miami City Tour and Boat Tour - Land & Sea Combo",
  ]),
  product(SKYLINE, "Miami Skyline Cruises", [
    "Miami Skyline Night Cruise",
    "Miami Sunset Cruise with the Mojito Bar On board",
  ]),
  product(SKYLINE, "Transportation"),
];

// Google OCR of three Everglades vouchers redeemed on 2026-09-04. The Groupon app
// draws its "1 of 2" badge inline with the title, so the text is split around it.
const EVERGLADES_VOUCHERS = [
  "←\n5:39 1\nVoucher Detail\n5G48\nХ\nEverglades Tour with Transportation 1 of 2\nfrom Miami for One Person\nKey West Sightseeing Tours\nRedemption Code\n7120414\nGroupon\nVS-729S-RVYR-252K-3N5R\nOriginal Price\n$55.00\nGroupon Price\n$40.50\nAmount Paid\n$36.09\nExpires\nMarch 3, 2027\nCUSTOMER\nMark As Used",
  "4:27 1\nVoucher Detail\n5G+73\nEverglades Tour with Transportation\n3 of 3\nfrom Miami for One Person\nKey West Sightseeing Tours\nRedemption Code\n991187\nGroupon\nVS-HVRY-PEG5-14SF-HTCT\nOriginal Price\n$55.00\nExpires\nMarch 3, 2027\nCUSTOMER\nJessica McLaughlin\nMark As Used",
  "11:23 1\n←\nVoucher Detail\nIl 5G+ 4\nEverglades Tour with\n1 of 1\nTransportation from Miami for Four\nPeople\nKey West Sightseeing Tours\nRedemption Code\n30073617\nGroupon\nVS-K1XT-R59P-MC7V-9WX7\nOriginal Price\n$220.00\nAmount Paid\n$0.00\nExpires\nMarch 2, 2027\nAll done? Mark this Groupon as\nused.\nSwipe to Mark as Used\nХ",
];

Deno.test("an Everglades voucher books Everglades, not the Transportation fee bucket", () => {
  for (const text of EVERGLADES_VOUCHERS) {
    const m = deterministicMatch(text, CATALOG);
    assertEquals(m?.candidate.product_name, "Everglades Tour");
    assertEquals(m?.method, "title");
  }
});

Deno.test("the answer does not depend on catalog row order", () => {
  const reversed = [...CATALOG].reverse();
  for (const text of EVERGLADES_VOUCHERS) {
    assertEquals(deterministicMatch(text, reversed)?.candidate.product_name, "Everglades Tour");
  }
});

Deno.test("a one-word product name never matches verbatim on its own", () => {
  // Only the category word and the storefront: nothing a title tier may act on, and the
  // merchant tier stays silent because this business sells several Groupon products.
  const text = "Voucher Detail\nTransportation\nMiami Skyline Cruises\nRedemption Code\n12345678";
  assertEquals(deterministicMatch(text, CATALOG), null);
});

Deno.test("a combo voucher lands on the combo, not the plain city tour", () => {
  const text =
    "Voucher Detail\nMiami City Tour and Boat Tour - Land & Sea Combo\n1 of 1\nMiami Skyline Cruises\nRedemption Code\n55512345";
  const m = deterministicMatch(text, CATALOG);
  assertEquals(m?.candidate.product_name, "Miami City Tour combo");
});

Deno.test("a title with a misread word still matches through the fuzzy tier", () => {
  const text =
    "Voucher Detail\nMiami Guided Jet Ski Tour | Biscayne Bay Adventure\n1 of 1\nMiami Skyline Cruises\nRedemption Code\n90001234";
  const m = deterministicMatch(text, CATALOG);
  assertEquals(m?.candidate.product_name, "Jet Ski");
  assertEquals(m?.method, "fuzzy");
});

Deno.test("the storefront alone decides only for a single-product business", () => {
  const text = "Voucher Detail\nKey West Sightseeing Tours\nRedemption Code\n12345678";
  const m = deterministicMatch(text, CATALOG);
  assertEquals(m?.candidate.product_name, "Key West Day Trips");
  assertEquals(m?.method, "merchant");
});
