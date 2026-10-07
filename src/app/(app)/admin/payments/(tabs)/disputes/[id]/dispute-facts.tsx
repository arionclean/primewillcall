import { CheckCircle2, ExternalLink } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { checkResult, disputeReason, type DisputeDetail } from "@/lib/payments/disputes";
import { bookingHref, formatNyDateTime, formatNyDeadline, money } from "@/lib/payments/format";
import { saleSourceLabel, stripeAccountUrl } from "@/lib/payments/stripe-reports";
import { formatUsPhoneDisplay } from "@/lib/sms/format";

/**
 * Everything the owner needs beside the answer: the money, the dispute, the
 * payment, the booking and the guest. The same facts Stripe's dispute page shows,
 * plus ours (the check-in, the tour, the desk), which are usually the evidence.
 */

type Row = { label: string; value: React.ReactNode } | null;

function FactCard({ title, rows, footer }: { title: string; rows: Row[]; footer?: React.ReactNode }) {
  const shown = rows.filter((r): r is NonNullable<Row> => r != null && r.value != null && r.value !== "");
  if (shown.length === 0 && !footer) return null;
  return (
    <Card>
      <CardContent className="py-4">
        <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
        <dl className="space-y-2 text-sm">
          {shown.map((r) => (
            <div key={r.label} className="flex justify-between gap-4">
              <dt className="shrink-0 text-muted-foreground">{r.label}</dt>
              <dd className="min-w-0 text-right">{r.value}</dd>
            </div>
          ))}
        </dl>
        {footer && <div className="mt-3 border-t pt-3">{footer}</div>}
      </CardContent>
    </Card>
  );
}

function capitalize(value: string | null): string | null {
  return value ? `${value[0].toUpperCase()}${value.slice(1).replace(/_/g, " ")}` : null;
}

const RISK: Record<string, string> = {
  normal: "Normal",
  elevated: "Elevated",
  highest: "High",
  not_assessed: "Not assessed",
};

const BOOKING_STATUS: Record<string, string> = {
  confirmed: "Confirmed",
  pending: "Pending",
  cancelled: "Cancelled",
  voided: "Voided",
};

export function DisputeFacts({ detail }: { detail: DisputeDetail }) {
  const { dispute, payment, booking, guest } = detail;
  const net = dispute.money.reinstated + dispute.money.feesReturned - dispute.money.withdrawn - dispute.money.fees;
  const href = booking ? bookingHref(booking.id, booking.startsAt) : null;

  return (
    <div className="space-y-4">
      <FactCard
        title="Money"
        rows={[
          { label: "Disputed", value: money(dispute.amount, dispute.currency) },
          dispute.money.withdrawn ? { label: "Taken by the bank", value: money(-dispute.money.withdrawn) } : null,
          dispute.money.fees ? { label: "Dispute fee", value: money(-dispute.money.fees) } : null,
          dispute.money.reinstated ? { label: "Returned", value: money(dispute.money.reinstated) } : null,
          dispute.money.feesReturned ? { label: "Fee returned", value: money(dispute.money.feesReturned) } : null,
          dispute.money.withdrawn || dispute.money.fees
            ? { label: "Net for the business", value: <span className="font-semibold">{money(net)}</span> }
            : null,
        ]}
      />

      <FactCard
        title="Dispute"
        rows={[
          { label: "Reason", value: disputeReason(dispute.reason) },
          dispute.networkReasonCode
            ? { label: "Card network code", value: `${capitalize(dispute.cardBrand) ?? ""} ${dispute.networkReasonCode}`.trim() }
            : null,
          { label: "Opened", value: formatNyDateTime(dispute.created) },
          dispute.dueBy ? { label: "Evidence due", value: formatNyDeadline(dispute.dueBy) } : null,
          dispute.isInquiry ? { label: "Stage", value: "Inquiry (no money taken yet)" } : null,
          { label: "Answers sent", value: String(dispute.submissionCount) },
        ]}
      />

      {payment && (
        <FactCard
          title="Payment"
          rows={[
            { label: "Amount", value: money(payment.amount) },
            { label: "Paid", value: formatNyDateTime(payment.created) },
            {
              label: "Card",
              value: [capitalize(payment.brand), payment.last4 ? `•••• ${payment.last4}` : null]
                .filter(Boolean)
                .join(" "),
            },
            payment.wallet ? { label: "Wallet", value: capitalize(payment.wallet) } : null,
            payment.country ? { label: "Card country", value: payment.country } : null,
            { label: "How it was paid", value: payment.readMethod ?? (payment.cardPresent ? "At the desk" : "Online") },
            !payment.cardPresent && checkResult(payment.cvcCheck)
              ? { label: "Security code", value: checkResult(payment.cvcCheck) }
              : null,
            !payment.cardPresent && checkResult(payment.postalCheck)
              ? { label: "ZIP code", value: checkResult(payment.postalCheck) }
              : null,
            !payment.cardPresent && checkResult(payment.threeDSecure)
              ? { label: "3D Secure", value: checkResult(payment.threeDSecure) }
              : null,
            payment.riskLevel ? { label: "Stripe risk", value: RISK[payment.riskLevel] ?? payment.riskLevel } : null,
            payment.amountRefunded ? { label: "Already refunded", value: money(payment.amountRefunded) } : null,
            payment.descriptor ? { label: "On the statement", value: payment.descriptor } : null,
          ]}
          footer={
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-medium">
              {payment.receiptUrl && (
                <a
                  href={payment.receiptUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                >
                  Receipt
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              )}
              <a
                href={stripeAccountUrl(detail.accountId)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
              >
                Open in Stripe
                <ExternalLink className="size-3" aria-hidden />
              </a>
            </div>
          }
        />
      )}

      {booking && (
        <FactCard
          title="Booking"
          rows={[
            booking.tourName ? { label: "Tour", value: booking.tourName } : null,
            { label: "Date", value: formatNyDateTime(booking.startsAt) },
            booking.guests ? { label: "Guests", value: booking.guests } : null,
            {
              label: "Checked in",
              value: booking.checkedInAt ? (
                <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 className="size-3.5" aria-hidden />
                  {formatNyDateTime(booking.checkedInAt)}
                </span>
              ) : (
                "No"
              ),
            },
            { label: "Status", value: BOOKING_STATUS[booking.status] ?? capitalize(booking.status) },
            saleSourceLabel(booking.source) ? { label: "Sold by", value: saleSourceLabel(booking.source) } : null,
            booking.ref ? { label: "Sale", value: booking.ref } : null,
          ]}
          footer={
            href ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Open the booking
                <ExternalLink className="size-3" aria-hidden />
              </a>
            ) : undefined
          }
        />
      )}

      {guest && (
        <FactCard
          title="Guest"
          rows={[
            guest.name ? { label: "Name", value: guest.name } : null,
            guest.email ? { label: "Email", value: <span className="break-all">{guest.email}</span> } : null,
            guest.phone ? { label: "Phone", value: formatUsPhoneDisplay(guest.phone) } : null,
          ]}
        />
      )}
    </div>
  );
}
