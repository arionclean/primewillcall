// Real Google OCR text from vouchers that went through /gp, replayed through the
// code finder. Run: deno test supabase/functions/_shared/gp-voucher-code.test.ts

import { assertEquals } from "jsr:@std/assert@1";
import { findVoucherCodes, looksLikeVoucherCode, pickVoucherCode } from "./gp-voucher-code.ts";

const UNDER_THE_BARCODE =
  "<\n7:00\nMy Groupon\n!!!! 5G 78\nдв\n1 Person: 90-Minute The Homes of 3 of 3\nthe Rich & Famous Boat Tour\nMiami Skyline Cruises\nRedemption Code\n21863636\nGroupon\nVS-PN55-943J-G3MM-43W5\nOriginal Price\n$28.00\nGroupon Price\n$16.20\nAmount Paid\n-$12.15\nBack\ngroupon.com";

const VOUCHER_DETAIL_PAGE =
  "←\n5:39 1\nVoucher Detail\n5G48\nХ\nEverglades Tour with Transportation 1 of 2\nfrom Miami for One Person\nKey West Sightseeing Tours\nRedemption Code\n7120414\nGroupon\nVS-729S-RVYR-252K-3N5R\nOriginal Price\n$55.00\nGroupon Price\n$40.50\nAmount Paid\n$36.09\nExpires\nMarch 3, 2027\nCUSTOMER\nMark As Used";

// Printed / PDF voucher: the code is a bare line after the expiry sentence.
const PRINTED_VOUCHER =
  "GROUPON\nKey West Sightseeing Tours\nMiami 5-in-1 City Tour for 1 with\nWater Bottle Included!\nEnjoy your experience before the promotional value expires on December 27,\n2026.\n13002288\nGet Groupon Mobile\nGO App >";

// The complaint: the app's voucher card, where the code sits behind a tap.
const CARD_WITH_HIDDEN_CODE =
  "8:271\n5G\n←\nMiami Skyline Cruises\n2 People: 90-Minute The Homes of the Rich & Famous Boat...\nRedemption Code\nReady to redeem\nHassle-free refund until: Aug 21, 2026\nShow All Vouchers (3)\nExpires on Feb\n14, 2027\nWant to give this voucher?\nMake it a Gift →\nGet help with this order. Click here\nHow to Use This Deal\n1. Pull up voucher with our mobile app (or print\nit out).\n2. Reservations Required, Call or Text (786)\n714-1314";

// Purchase confirmation screen: an order number, no code.
const CONFIRMATION_SCREEN =
  "Х\n1:08 1\nConfirmation\nOrder #1000-152533-584431 Purchased!\nMiami Star Island Cruises\nMiami Star Island 90 Minute Cruise - The Homes of The\nRich & Famous - 2 People\nReady To Redeem Expires on Feb 27, 2027\n3 days hassle-free refund guarantee";

Deno.test("both codes are read from under the barcode", () => {
  assertEquals(findVoucherCodes(UNDER_THE_BARCODE), {
    redemption: "21863636",
    groupon: "VS-PN55-943J-G3MM-43W5",
    bare: "21863636",
  });
});

Deno.test("a 7 digit redemption code still counts", () => {
  assertEquals(findVoucherCodes(VOUCHER_DETAIL_PAGE).redemption, "7120414");
});

Deno.test("the label and the digits may share a line, even with the merchant between", () => {
  assertEquals(
    findVoucherCodes("Miami Skyline Cruises Redemption Code 42348639 Groupon VS-NKM7-S116-XMSR-MHC7 Original").redemption,
    "42348639",
  );
  assertEquals(findVoucherCodes("REDEMPTION CODE\nMiami Skyline Cruises 92347214\n9234-7214").redemption, "92347214");
});

Deno.test("a printed voucher's bare code line is found", () => {
  assertEquals(findVoucherCodes(PRINTED_VOUCHER), { redemption: null, groupon: null, bare: "13002288" });
  assertEquals(pickVoucherCode(null, PRINTED_VOUCHER), "13002288");
});

Deno.test("the voucher card with the code behind a tap yields nothing", () => {
  assertEquals(findVoucherCodes(CARD_WITH_HIDDEN_CODE), { redemption: null, groupon: null, bare: null });
  assertEquals(pickVoucherCode(null, CARD_WITH_HIDDEN_CODE), null);
});

Deno.test("a purchase confirmation's order number is not a code", () => {
  assertEquals(pickVoucherCode(null, CONFIRMATION_SCREEN), null);
});

Deno.test("prices and dates are never mistaken for a code", () => {
  assertEquals(findVoucherCodes("Redemption Code\nGroupon Price\n$16.20\nAmount Paid\n-$12.15\nExpires on Feb 14, 2027"), {
    redemption: null,
    groupon: null,
    bare: null,
  });
});

Deno.test("the text wins over the model, and a garbage model answer is rejected", () => {
  assertEquals(pickVoucherCode("VS-PN55-943J-G3MM-43W5", UNDER_THE_BARCODE), "21863636");
  assertEquals(pickVoucherCode("0005G", CARD_WITH_HIDDEN_CODE), null);
  assertEquals(pickVoucherCode("98018821", "text the OCR mangled"), "98018821");
  assertEquals(looksLikeVoucherCode("VS-ZXVL-T7TG-LFLM-VV7K"), true);
  assertEquals(looksLikeVoucherCode("Ready to redeem"), false);
});
