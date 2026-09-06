/**
 * Find the voucher code in the OCR text of a Groupon voucher.
 *
 * Staff redeem a voucher on Groupon by its numeric Redemption Code, so a
 * booking is only useful to them when that code is on file. Groupon shows it
 * in three layouts:
 *
 *   App "Voucher" screen        Printed / PDF voucher          Under the barcode
 *   ---------------------       ---------------------          ----------------
 *   Redemption Code             ...expires on March 3, 2027.   Redemption Code
 *   21863636                    43213729                       21863636
 *   Groupon                                                    Groupon
 *   VS-PN55-943J-GXMM-43W5                                     VS-PN55-...
 *
 * And one layout that does NOT show it, which is the whole problem: the app's
 * voucher card, where the label "Redemption Code" is followed by a "Ready to
 * redeem" button and the code itself only appears after a tap. Customers
 * screenshot that card constantly. Graded on 156 stored uploads, every
 * screenshot without a readable code was one of: that card, the "My Groupons"
 * list, the purchase confirmation, or an unrelated page.
 *
 * The finder is deterministic and only ever reports a string that appears
 * verbatim in the OCR text. The AI extraction in gp-voucher-vision is the
 * fallback, and its answer counts only when it is shaped like a code: it has
 * returned "0005G" (a status-bar icon) before, and that must not pass for a
 * code. Null from `pickVoucherCode` therefore means the image shows no code,
 * which is what gp-validate turns into "take the screenshot again with the
 * Redemption Code visible".
 */

export interface VoucherCodes {
  /** The numeric code printed right under a "Redemption Code" label. */
  redemption: string | null;
  /** The "Groupon" number, VS-XXXX-XXXX-XXXX-XXXX. */
  groupon: string | null;
  /** A line that is nothing but 6 to 10 digits (the printed-voucher layout). */
  bare: string | null;
}

// "Redemption Code", then the first run of 6 to 10 digits within a short
// stretch of non-digits (a newline, a colon, sometimes the merchant name on
// the same line). Prices never qualify: they carry "$" and a decimal point,
// and dates are 1, 2 or 4 digits.
const REDEMPTION_RE = /redemption\s*code\D{0,40}?(\d{6,10})\b/i;
// The Groupon number. OCR keeps the dashes reliably.
const GROUPON_RE = /\bVS(?:-[A-Z0-9]{4}){4}\b/i;
// A whole line of digits. Order numbers ("#1000-152533-584431"), phone numbers
// and times all carry punctuation, so they never match.
const BARE_LINE_RE = /^\s*(\d{6,10})\s*$/m;
// What a code returned by the model must look like to be believed.
const CODE_SHAPE_RE = /^(?:\d{6,10}|VS(?:-[A-Z0-9]{4}){4})$/i;

export function findVoucherCodes(ocrText: string): VoucherCodes {
  const text = String(ocrText ?? "");
  const red = REDEMPTION_RE.exec(text);
  const gp = GROUPON_RE.exec(text);
  const bare = BARE_LINE_RE.exec(text);
  return {
    redemption: red ? red[1] : null,
    groupon: gp ? gp[0].toUpperCase() : null,
    bare: bare ? bare[1] : null,
  };
}

/** True when a model answer is shaped like a real Groupon code. */
export function looksLikeVoucherCode(code: string | null | undefined): boolean {
  return typeof code === "string" && CODE_SHAPE_RE.test(code.trim());
}

/**
 * The single code to store for a voucher, most trustworthy source first: the
 * labelled Redemption Code, then a bare numeric line, then the Groupon number,
 * then the model's answer if it is shaped like a code. Null means the image
 * shows no code at all.
 */
export function pickVoucherCode(
  modelCode: string | null | undefined,
  ocrText: string,
): string | null {
  const found = findVoucherCodes(ocrText);
  if (found.redemption) return found.redemption;
  if (found.bare) return found.bare;
  if (found.groupon) return found.groupon;
  return looksLikeVoucherCode(modelCode) ? modelCode!.trim() : null;
}
