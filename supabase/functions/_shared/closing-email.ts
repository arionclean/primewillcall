// The end-of-night closing statement, as an email.
//
// The tablet prints the paper form for the desk to sign; this is the same figures
// sent to whoever watches the money, so they see the night without waiting for the
// paper. Commission and the counted cash are deliberately absent: those are worked
// out and signed at the desk, and the email says so rather than showing blanks that
// look like zeroes.

export interface ClosingReport {
  /** The till itself, e.g. "Miami kiosk (kiosk3)". This is what tells two kiosks apart. */
  kioskName: string;
  kioskSlug: string;
  /** The business the till sells for, e.g. "Miami Skyline Cruises". */
  businessName: string;
  dateLabel: string;
  representative?: string | null;
  totalSales: number;
  creditSales: number;
  cashSales: number;
  totalCount: number;
  cardCount: number;
  cashCount: number;
  products: { name: string; count: number; amount: number }[];
  printedAt: string;
}

const money = (amount: number): string =>
  `$${amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Subject line: which till, the number that matters, then when. */
export const closingSubject = (r: ClosingReport): string =>
  `${r.kioskName}: ${money(r.totalSales)} on ${r.dateLabel}`;

/** Plain text, for mail clients that refuse HTML. Same figures, same order. */
export function closingText(r: ClosingReport): string {
  const lines = [
    `${r.kioskName} closing statement`,
    r.businessName,
    r.dateLabel,
    "",
    `Total sales   ${money(r.totalSales)}`,
    `  Card        ${money(r.creditSales)} (${r.cardCount})`,
    `  Cash        ${money(r.cashSales)} (${r.cashCount})`,
    `Transactions  ${r.totalCount}`,
    "",
    r.representative ? `Closed by ${r.representative}` : "Closed by (unsigned)",
    "",
    "Products sold",
  ];
  r.products.forEach((p) => lines.push(`  ${p.name} x${p.count}  ${money(p.amount)}`));
  lines.push("", `Printed ${r.printedAt}`);
  lines.push("Commission and the counted cash are filled in on the printed form.");
  return lines.join("\n");
}

export function closingHtml(r: ClosingReport): string {
  const productRows = r.products
    .map(
      (p, i) => `
        <tr>
          <td style="padding:12px 16px;border-top:1px solid #e8ecf1;color:#0f172a;font-size:15px;${
            i === 0 ? "border-top:none;" : ""
          }">${escapeHtml(p.name)}</td>
          <td style="padding:12px 8px;border-top:1px solid #e8ecf1;color:#64748b;font-size:15px;text-align:center;white-space:nowrap;${
            i === 0 ? "border-top:none;" : ""
          }">&times;${p.count}</td>
          <td style="padding:12px 16px;border-top:1px solid #e8ecf1;color:#0f172a;font-size:15px;text-align:right;font-weight:600;white-space:nowrap;${
            i === 0 ? "border-top:none;" : ""
          }">${money(p.amount)}</td>
        </tr>`,
    )
    .join("");

  const splitCell = (
    label: string,
    amount: number,
    count: number,
    accent: string,
  ): string => `
    <td width="50%" style="padding:0 6px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e8ecf1;border-radius:12px;">
        <tr><td style="padding:16px;">
          <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#94a3b8;font-weight:600;">${label}</div>
          <div style="margin-top:6px;font-size:24px;font-weight:700;color:${accent};">${money(amount)}</div>
          <div style="margin-top:2px;font-size:13px;color:#94a3b8;">${count} ${count === 1 ? "sale" : "sales"}</div>
        </td></tr>
      </table>
    </td>`;

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;">
  <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(
    `${r.kioskName}: ${money(r.totalSales)} across ${r.totalCount} sales. Card ${money(
      r.creditSales,
    )}, cash ${money(r.cashSales)}.`,
  )}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

        <tr><td style="background:#0f172a;border-radius:16px 16px 0 0;padding:28px 28px 24px;">
          <div style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#7c8ba1;font-weight:600;">Closing statement</div>
          <div style="margin-top:10px;">
            <span style="display:inline-block;background:#2563eb;color:#ffffff;font-size:13px;font-weight:700;letter-spacing:.04em;padding:6px 12px;border-radius:999px;">${escapeHtml(
              r.kioskName,
            )}</span>
          </div>
          <div style="margin-top:12px;font-size:20px;font-weight:700;color:#ffffff;">${escapeHtml(
            r.businessName,
          )}</div>
          <div style="margin-top:4px;font-size:15px;color:#94a3b8;">${escapeHtml(r.dateLabel)}</div>
        </td></tr>

        <tr><td style="background:#1e293b;padding:24px 28px 28px;">
          <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#7c8ba1;font-weight:600;">Total sales</div>
          <div style="margin-top:4px;font-size:40px;line-height:1.1;font-weight:700;color:#ffffff;">${money(r.totalSales)}</div>
          <div style="margin-top:6px;font-size:14px;color:#94a3b8;">${r.totalCount} ${
    r.totalCount === 1 ? "transaction" : "transactions"
  }</div>
        </td></tr>

        <tr><td style="background:#ffffff;padding:20px 22px 8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            ${splitCell("Card", r.creditSales, r.cardCount, "#7c3aed")}
            ${splitCell("Cash", r.cashSales, r.cashCount, "#16a34a")}
          </tr></table>
        </td></tr>

        ${
          r.products.length > 0
            ? `<tr><td style="background:#ffffff;padding:20px 28px 8px;">
                 <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#94a3b8;font-weight:600;padding-bottom:10px;">Products sold</div>
                 <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8ecf1;border-radius:12px;border-collapse:separate;overflow:hidden;">
                   ${productRows}
                 </table>
               </td></tr>`
            : ""
        }

        <tr><td style="background:#ffffff;padding:20px 28px 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:12px;">
            <tr><td style="padding:16px 18px;">
              <div style="font-size:14px;color:#0f172a;"><strong>Closed by</strong> ${
                r.representative
                  ? escapeHtml(r.representative)
                  : '<span style="color:#94a3b8;">not signed on the tablet</span>'
              }</div>
              <div style="margin-top:8px;font-size:13px;color:#64748b;line-height:1.5;">
                Commission and the counted cash are written on the printed form at the desk, so they are not in this email.
              </div>
            </td></tr>
          </table>
        </td></tr>

        <tr><td style="background:#ffffff;border-radius:0 0 16px 16px;padding:0 28px 24px;">
          <div style="border-top:1px solid #e8ecf1;padding-top:16px;font-size:12px;color:#94a3b8;">
            ${escapeHtml(r.kioskName)} &middot; ${escapeHtml(r.kioskSlug)} &middot; printed ${escapeHtml(
              r.printedAt,
            )}
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
