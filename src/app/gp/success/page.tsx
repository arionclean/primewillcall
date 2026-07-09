import Link from "next/link";

// Public confirmation shown after a Groupon customer completes Stripe Checkout.
// The booking is flipped to `confirmed` by the Stripe webhook
// (checkout.session.completed); this page just reassures the customer.

const SUPPORT_PHONE_DISPLAY = "+1 (786) 714-1314";
const SUPPORT_PHONE_TEL = "+17867141314";

export default function GpSuccessPage() {
  return (
    <div className="gp-ok-root">
      <style>{CSS}</style>
      <main className="gp-ok-page">
        <section className="gp-ok-card">
          <div className="gp-ok-badge" aria-hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </div>
          <h1 className="gp-ok-title">Payment received</h1>
          <p className="gp-ok-body">
            Your reservation is confirmed and your convenience fee has been paid.
            A receipt was sent by Stripe to the email you entered at checkout.
          </p>
          <p className="gp-ok-body">
            Questions about your reservation? Call us at {SUPPORT_PHONE_DISPLAY}.
          </p>
          <div className="gp-ok-actions">
            <Link className="gp-ok-btn" href="/gp">
              Redeem another voucher
            </Link>
            <a className="gp-ok-assist" href={`tel:${SUPPORT_PHONE_TEL}`}>
              Need help? {SUPPORT_PHONE_DISPLAY}
            </a>
          </div>
        </section>
      </main>
    </div>
  );
}

const CSS = `
.gp-ok-root {
  --gp-bg: #245847;
  --gp-green-ink: #2d5f4a;
  --gp-accent: #4f46e5;
  --gp-accent-2: #6366f1;
  min-height: 100vh;
  background:
    radial-gradient(circle at 18% -12%, rgba(255,255,255,0.08) 0, rgba(255,255,255,0) 40%),
    radial-gradient(circle at 82% 120%, rgba(0,0,0,0.12) 0, rgba(0,0,0,0) 45%),
    var(--gp-bg);
  color: #e8f0ec;
  font-family: "Manrope", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  display: grid;
  place-items: center;
  padding: 24px 16px;
}
.gp-ok-page { width: min(560px, 100%); }
.gp-ok-card { background: #ededee; border-radius: 16px; padding: 28px 22px; color: #4c4f54; display: grid; gap: 14px; justify-items: center; text-align: center; }
.gp-ok-badge { width: 64px; height: 64px; border-radius: 999px; display: grid; place-items: center; color: #fff; background: linear-gradient(135deg, #22a06b, #2d5f4a); }
.gp-ok-badge svg { width: 34px; height: 34px; }
.gp-ok-title { margin: 0; font-size: clamp(22px, 3vw, 30px); font-weight: 800; color: var(--gp-green-ink); }
.gp-ok-body { margin: 0; font-size: 15px; line-height: 1.4; max-width: 440px; }
.gp-ok-actions { display: grid; gap: 10px; width: 100%; max-width: 380px; margin-top: 6px; }
.gp-ok-btn { min-height: 50px; display: inline-flex; align-items: center; justify-content: center; border-radius: 12px; border: 0; font-weight: 700; font-size: 16px; color: #fff; text-decoration: none; background: linear-gradient(135deg, var(--gp-accent), var(--gp-accent-2)); box-shadow: 0 8px 16px rgba(79,70,229,0.25); }
.gp-ok-assist { min-height: 46px; display: inline-flex; align-items: center; justify-content: center; border-radius: 12px; border: 2px solid var(--gp-green-ink); color: var(--gp-green-ink); font-weight: 700; font-size: 15px; text-decoration: none; background: rgba(255,255,255,0.45); }
`;
