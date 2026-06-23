"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Public Groupon voucher-redemption flow, ported from the legacy Bubble/Xano
// widget. Three steps: upload the voucher -> confirm details -> pay. The design
// (green theme, light cards, step pills, upload arrow, invalid modal) mirrors the
// original; the logic is rewired to this app's /api/gp/* routes. Payment is the
// final migration phase, so the checkout step is stubbed for now.

const SUPPORT_PHONE_DISPLAY = "+1 (786) 714-1314";
const SUPPORT_PHONE_TEL = "+17867141314";
const MAX_WIDTH = 1280;
const JPEG_QUALITY = 0.7;

type Match = {
  businessTourId: string;
  businessName: string;
  productName: string;
  feeCents: number;
  passengers: number; // total across every uploaded voucher for this product
  voucherCodes: string[]; // every redemption code collected so far
};

type Slot = { value: string; label: string; durationMinutes: number };

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function maskPhone(digits: string): string {
  const d = digits.slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/** Downscale + re-encode to JPEG so OCR is fast and the upload is small. */
async function resizeToJpegBlob(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/")) return file;
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("load failed"));
    image.src = dataUrl;
  });
  let { width, height } = img;
  if (width > MAX_WIDTH) {
    height = Math.round(height * (MAX_WIDTH / width));
    width = MAX_WIDTH;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(img, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/jpeg", JPEG_QUALITY),
  );
  return blob ?? file;
}

export function GrouponFlow() {
  const fileRef = useRef<HTMLInputElement>(null);
  const detailsRef = useRef<HTMLDivElement>(null);
  const paymentRef = useRef<HTMLDivElement>(null);

  const [uploading, setUploading] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [gallery, setGallery] = useState<string[]>([]);
  const [match, setMatch] = useState<Match | null>(null);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState(""); // digits only
  const [date, setDate] = useState("");
  const [minDate, setMinDate] = useState("");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotsMsg, setSlotsMsg] = useState("Select date first");
  const [slotValue, setSlotValue] = useState("");

  const [showPayment, setShowPayment] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmed, setConfirmed] = useState<{ totalCents: number } | null>(null);

  const [modal, setModal] = useState<{ open: boolean; message: string; preview: string | null }>({
    open: false,
    message: "",
    preview: null,
  });

  useEffect(() => {
    // Set the date floor on the client to avoid a hydration mismatch.
    const ny = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    setMinDate(ny);
  }, []);

  const continueEnabled = Boolean(name.trim()) && Boolean(slotValue);

  const loadSlots = useCallback(
    async (forDate: string, businessTourId: string | undefined) => {
      if (!businessTourId) {
        setSlots([]);
        setSlotValue("");
        setSlotsMsg("Upload a valid voucher first");
        return;
      }
      if (!forDate) {
        setSlots([]);
        setSlotValue("");
        setSlotsMsg("Select date first");
        return;
      }
      setSlots([]);
      setSlotValue("");
      setSlotsMsg("Loading times...");
      try {
        const res = await fetch(
          `/api/gp/slots?business_tour_id=${encodeURIComponent(businessTourId)}&date=${encodeURIComponent(forDate)}`,
        );
        const json = (await res.json()) as { slots?: Slot[] };
        const next = json.slots ?? [];
        if (next.length === 0) {
          setSlotsMsg("No times available");
          return;
        }
        setSlots(next);
        setSlotsMsg("");
      } catch {
        setSlotsMsg("Unable to load times");
      }
    },
    [],
  );

  function focusSection(el: HTMLElement | null) {
    if (!el) return;
    requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  async function handleFile(file: File) {
    setUploading(true);
    setStatusMsg("");
    const localPreview = URL.createObjectURL(file);
    try {
      const blob = await resizeToJpegBlob(file);
      const form = new FormData();
      form.append("file", blob, "voucher.jpg");

      const res = await fetch("/api/gp/validate", { method: "POST", body: form });
      const json = (await res.json()) as {
        valid?: boolean;
        businessTourId?: string;
        businessName?: string;
        productName?: string;
        feeCents?: number;
        passengers?: number;
        voucherCode?: string | null;
        imageUrl?: string | null;
        reason?: string;
        message?: string;
      };

      if (json.valid && json.businessTourId) {
        // Vouchers for a different experience can't share one reservation.
        if (match && match.businessTourId !== json.businessTourId) {
          setModal({
            open: true,
            message: `This voucher is for "${json.productName ?? "another experience"}", but you've already started a reservation for "${match.productName}". Please redeem each experience separately. Questions? Call ${SUPPORT_PHONE_DISPLAY}.`,
            preview: localPreview,
          });
          return;
        }
        // Re-uploading the same voucher must not double-count guests.
        const incomingCode = json.voucherCode ?? null;
        if (incomingCode && match?.voucherCodes.includes(incomingCode)) {
          setModal({
            open: true,
            message: `That voucher (code ${incomingCode}) was already added.`,
            preview: localPreview,
          });
          return;
        }
        // Additive: sum the guests and collect every code across uploads.
        const voucherCodes = match ? [...match.voucherCodes] : [];
        if (incomingCode) voucherCodes.push(incomingCode);
        const next: Match = {
          businessTourId: json.businessTourId,
          businessName: json.businessName ?? match?.businessName ?? "",
          productName: json.productName ?? match?.productName ?? "",
          feeCents: json.feeCents ?? match?.feeCents ?? 0,
          passengers: (match?.passengers ?? 0) + (json.passengers ?? 1),
          voucherCodes,
        };
        setMatch(next);
        setGallery((g) => [...g, json.imageUrl ?? localPreview]);
        setShowPayment(false);
        setConfirmed(null);
        focusSection(detailsRef.current);
        loadSlots(date, next.businessTourId);
      } else {
        setShowPayment(false);
        setModal({
          open: true,
          message:
            json.message ||
            json.reason ||
            `We could not match that voucher. Call us at ${SUPPORT_PHONE_DISPLAY} for help.`,
          preview: localPreview,
        });
      }
    } catch {
      setModal({
        open: true,
        message: `Something went wrong uploading your voucher. Call us at ${SUPPORT_PHONE_DISPLAY}.`,
        preview: localPreview,
      });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleCheckout() {
    if (!match || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/gp/book", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          businessTourId: match.businessTourId,
          customerName: name.trim(),
          phone,
          date,
          slotStart: slotValue,
          passengers: match.passengers,
          voucherCodes: match.voucherCodes,
          imageUrl: gallery[gallery.length - 1] ?? null,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; totalCents?: number; message?: string };
      if (json.ok) {
        setConfirmed({ totalCents: json.totalCents ?? match.feeCents * match.passengers });
      } else {
        setStatusMsg(json.message ?? "Could not complete your reservation. Please try again.");
      }
    } catch {
      setStatusMsg("Could not complete your reservation. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const totalCents = match ? match.feeCents * match.passengers : 0;

  return (
    <div className="gp-root">
      <style>{CSS}</style>

      <main className="gp-page">
        <header className="gp-hero">
          <h1>Convenience Fee for Groupon Customers</h1>
          <p className="gp-helper">Vouchers are redeemed at the time of reservation.</p>
        </header>

        {/* Step 1: upload */}
        <section className="gp-card" aria-label="Step 1 voucher upload">
          <div className="gp-step-header">
            <span className="gp-pill">Step 1</span>
            <h2 className="gp-title">Upload your Groupon voucher</h2>
          </div>

          <div className="gp-panel gp-upload">
            <figure className="gp-preview">
              {gallery.length === 0 ? (
                <div className="gp-preview-empty">
                  <UploadIcon />
                  <span>Your voucher photo appears here</span>
                </div>
              ) : (
                <div className="gp-gallery">
                  {gallery.map((src, i) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={i} src={src} alt={`Voucher ${i + 1}`} />
                  ))}
                </div>
              )}
            </figure>

            <div className="gp-upload-controls">
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                }}
              />
              <div className="gp-arrow" aria-hidden>
                <ArrowDownIcon />
              </div>
              <div className="gp-upload-actions">
                <button
                  type="button"
                  className="gp-btn-upload"
                  disabled={uploading}
                  onClick={() => fileRef.current?.click()}
                >
                  {uploading ? "Reading voucher..." : "Upload image"}
                </button>
                {gallery.length > 0 && (
                  <button
                    type="button"
                    className="gp-btn-clear"
                    disabled={uploading}
                    onClick={() => {
                      setGallery([]);
                      setMatch(null);
                      setShowPayment(false);
                      setConfirmed(null);
                      setSlots([]);
                      setSlotValue("");
                      setSlotsMsg("Select date first");
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
              {uploading && (
                <div className="gp-loader" role="status">
                  <span className="gp-spinner" /> Checking your voucher...
                </div>
              )}
              {statusMsg && !modal.open && <p className="gp-status">{statusMsg}</p>}
            </div>
          </div>
        </section>

        {/* Step 2: details */}
        {match && (
          <section ref={detailsRef} className="gp-card" aria-label="Step 2 customer details">
            <div className="gp-step-header">
              <span className="gp-pill">Step 2</span>
              <h2 className="gp-title">Your details</h2>
            </div>

            <div className="gp-panel gp-form">
              <div className="gp-row">
                <label className="gp-label" htmlFor="gp-name">
                  Name
                </label>
                <input
                  id="gp-name"
                  className="gp-input"
                  type="text"
                  placeholder="Full name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="gp-row">
                <label className="gp-label" htmlFor="gp-date">
                  Date
                </label>
                <div className="gp-split">
                  <input
                    id="gp-date"
                    className="gp-input"
                    type="date"
                    min={minDate}
                    value={date}
                    onChange={(e) => {
                      setDate(e.target.value);
                      setShowPayment(false);
                      loadSlots(e.target.value, match.businessTourId);
                    }}
                  />
                  <select
                    className="gp-input"
                    value={slotValue}
                    disabled={slots.length === 0}
                    onChange={(e) => {
                      setSlotValue(e.target.value);
                      setShowPayment(false);
                    }}
                  >
                    <option value="">{slots.length === 0 ? slotsMsg || "time" : "Pick a time"}</option>
                    {slots.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="gp-row gp-summary">
                <span className="gp-label">Product</span>
                <span className="gp-readonly">{match.productName}</span>
              </div>
              <div className="gp-row gp-summary">
                <span className="gp-label">Guests</span>
                <span className="gp-readonly">{match.passengers}</span>
              </div>
              <div className="gp-row gp-summary">
                <span className="gp-label">Fee per guest</span>
                <span className="gp-readonly">{formatUsd(match.feeCents)}</span>
              </div>

              <div className="gp-row">
                <label className="gp-label" htmlFor="gp-phone">
                  Phone
                </label>
                <div className="gp-phone">
                  <span className="gp-flag">🇺🇸</span>
                  <span className="gp-prefix">+1</span>
                  <input
                    id="gp-phone"
                    className="gp-phone-input"
                    type="tel"
                    inputMode="numeric"
                    placeholder="(201) 555-0123"
                    value={maskPhone(phone)}
                    onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
                  />
                </div>
              </div>

              <div className="gp-actions-right">
                <button
                  type="button"
                  className="gp-btn-primary"
                  disabled={!continueEnabled}
                  onClick={() => {
                    setShowPayment(true);
                    focusSection(paymentRef.current);
                  }}
                >
                  Continue
                </button>
              </div>
            </div>
          </section>
        )}

        {/* Step 3: payment (stubbed) */}
        {match && showPayment && (
          <section ref={paymentRef} className="gp-card" aria-label="Step 3 payment">
            <div className="gp-step-header">
              <span className="gp-pill">Step 3</span>
              <h2 className="gp-title">Payment</h2>
            </div>

            <div className="gp-panel gp-pay">
              {confirmed ? (
                <div className="gp-confirm">
                  <p className="gp-confirm-title">You&apos;re on the list.</p>
                  <p className="gp-confirm-body">
                    Your reservation is held. A team member will confirm your voucher and collect the{" "}
                    {formatUsd(confirmed.totalCents)} convenience fee. Questions? Call {SUPPORT_PHONE_DISPLAY}.
                  </p>
                </div>
              ) : (
                <>
                  <div className="gp-total">
                    <span>Total convenience fee</span>
                    <strong>{formatUsd(totalCents)}</strong>
                    <small>
                      {match.passengers} guest{match.passengers === 1 ? "" : "s"} × {formatUsd(match.feeCents)}
                    </small>
                  </div>
                  <button
                    type="button"
                    className="gp-btn-checkout"
                    disabled={submitting}
                    onClick={handleCheckout}
                  >
                    {submitting ? "Reserving..." : "Reserve my spot"}
                  </button>
                  {statusMsg && <p className="gp-status gp-status-error">{statusMsg}</p>}
                  <a className="gp-btn-assist" href={`tel:${SUPPORT_PHONE_TEL}`}>
                    Need assistance? {SUPPORT_PHONE_DISPLAY}
                  </a>
                </>
              )}
            </div>
          </section>
        )}
      </main>

      {modal.open && (
        <div className="gp-modal-backdrop" onClick={() => setModal((m) => ({ ...m, open: false }))}>
          <div
            className="gp-modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <WarnIcon />
            <p className="gp-modal-msg">{modal.message}</p>
            {modal.preview && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="gp-modal-preview" src={modal.preview} alt="Uploaded voucher" />
            )}
            <div className="gp-modal-actions">
              <a className="gp-btn-primary" href={`tel:${SUPPORT_PHONE_TEL}`}>
                Call {SUPPORT_PHONE_DISPLAY}
              </a>
              <button
                type="button"
                className="gp-btn-clear"
                onClick={() => setModal((m) => ({ ...m, open: false }))}
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 16V4" />
      <path d="M7 9l5-5 5 5" />
      <path d="M5 20h14" />
    </svg>
  );
}

function ArrowDownIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v14" />
      <path d="M6.5 11.7 12 17.2l5.5-5.5" />
      <path d="M5 19h14" />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg className="gp-modal-icon" viewBox="0 0 24 24" aria-hidden>
      <path fill="#f4b01d" d="M12 3.2 1.8 20.8h20.4L12 3.2zm1.2 13.7h-2.4v-2.4h2.4v2.4zm0-4.6h-2.4V7.9h2.4v4.4z" />
    </svg>
  );
}

const CSS = `
.gp-root {
  --gp-bg: #245847;
  --gp-card: #ededee;
  --gp-panel: #cfd4d7;
  --gp-ink: #1f1f23;
  --gp-text: #4c4f54;
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
}
.gp-page { max-width: 920px; margin: 0 auto; padding: 28px 16px 48px; display: grid; gap: 18px; }
.gp-hero h1 { margin: 0; font-size: clamp(24px, 3.4vw, 38px); font-weight: 700; line-height: 1.1; }
.gp-helper { margin: 6px 0 0; font-size: clamp(14px, 1.8vw, 19px); opacity: 0.95; }
.gp-card { background: var(--gp-card); border-radius: 16px; padding: 16px; color: var(--gp-text); animation: gp-rise 320ms ease both; }
.gp-step-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.gp-pill { background: var(--gp-ink); color: #fff; border-radius: 999px; padding: 5px 14px; font-size: 13px; font-weight: 800; }
.gp-title { margin: 0; font-size: clamp(18px, 2.4vw, 26px); font-weight: 700; color: #46494d; }
.gp-panel { background: var(--gp-panel); border-radius: 14px; padding: 16px; }

.gp-upload { display: grid; grid-template-columns: minmax(0, 280px) 1fr; gap: 18px; align-items: start; }
.gp-preview { margin: 0; width: 100%; height: 320px; border-radius: 14px; overflow: hidden; background: #d4d8db; box-shadow: inset 0 0 0 1px rgba(70,74,77,0.08); }
.gp-preview-empty { width: 100%; height: 100%; display: grid; place-content: center; gap: 8px; justify-items: center; color: #8a9096; font-size: 13px; text-align: center; padding: 16px; }
.gp-preview-empty svg { width: 42px; height: 42px; color: var(--gp-green-ink); }
.gp-gallery { width: 100%; height: 100%; padding: 8px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; overflow: auto; align-content: start; }
.gp-gallery img { width: 100%; aspect-ratio: 3 / 5; object-fit: cover; border-radius: 10px; }
.gp-upload-controls { display: grid; gap: 12px; align-content: start; }
.gp-arrow { display: flex; justify-content: center; }
.gp-arrow svg { width: 54px; height: 54px; color: var(--gp-green-ink); animation: gp-hint 1.5s ease-in-out infinite; }
.gp-upload-actions { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; }
.gp-loader { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #4b4f52; justify-content: center; }
.gp-spinner { width: 16px; height: 16px; border: 3px solid rgba(0,0,0,0.2); border-top-color: rgba(0,0,0,0.65); border-radius: 50%; animation: gp-spin 0.8s linear infinite; }
.gp-status { margin: 0; font-size: 13px; font-weight: 600; color: #4b4f52; text-align: center; }
.gp-status-error { color: #b83a3a; }

.gp-form { display: grid; gap: 12px; }
.gp-row { display: grid; grid-template-columns: minmax(0, 34%) minmax(0, 1fr); align-items: center; gap: 12px; }
.gp-label { font-size: 15px; font-weight: 600; color: #4b4f52; }
.gp-input { min-width: 0; width: 100%; min-height: 48px; border-radius: 12px; border: 2px solid #c7ccd0; background: #d8dde0; padding: 0 14px; font-family: inherit; font-size: 16px; color: #1f2328; }
.gp-input:focus { outline: none; border-color: #aab1b9; box-shadow: 0 4px 12px rgba(25,31,29,0.12); }
.gp-split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 150px); gap: 8px; }
.gp-summary { align-items: center; }
.gp-readonly { justify-self: end; font-size: 16px; font-weight: 700; color: #4f5660; }
.gp-phone { display: flex; align-items: center; gap: 8px; min-height: 48px; border-radius: 12px; border: 2px solid #bcc2c6; background: #d9dde0; padding: 0 12px; }
.gp-flag { font-size: 20px; }
.gp-prefix { font-weight: 700; color: #59606a; font-size: 14px; }
.gp-phone-input { flex: 1; min-width: 0; border: 0; background: transparent; font-family: inherit; font-size: 16px; color: #1f2328; }
.gp-phone-input:focus { outline: none; }
.gp-actions-right { display: flex; justify-content: flex-end; padding-top: 4px; }

.gp-btn-primary { min-height: 48px; min-width: 160px; border: 0; border-radius: 12px; padding: 0 20px; font-family: inherit; font-size: 16px; font-weight: 700; color: #fff; background: linear-gradient(135deg, var(--gp-accent), var(--gp-accent-2)); box-shadow: 0 8px 16px rgba(79,70,229,0.25); cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; transition: transform 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease; }
.gp-btn-primary:hover { transform: translateY(-1px); }
.gp-btn-primary:disabled { background: #d9dde0; color: #a6abb4; box-shadow: none; cursor: not-allowed; transform: none; }
.gp-btn-upload { min-height: 46px; border: 0; border-radius: 10px; padding: 0 22px; font-family: inherit; font-size: 15px; font-weight: 700; color: #fff; background: linear-gradient(135deg, var(--gp-accent), var(--gp-accent-2)); box-shadow: 0 6px 18px rgba(79,70,229,0.25); cursor: pointer; }
.gp-btn-upload:disabled { opacity: 0.6; cursor: not-allowed; }
.gp-btn-clear { min-height: 46px; border: 1px solid #bcc3cb; border-radius: 10px; padding: 0 18px; font-family: inherit; font-size: 14px; font-weight: 600; color: #4f545a; background: #eceef1; cursor: pointer; }
.gp-btn-clear:disabled { opacity: 0.6; cursor: not-allowed; }

.gp-pay { display: grid; place-items: center; gap: 14px; text-align: center; }
.gp-total { display: grid; gap: 2px; }
.gp-total span { font-size: 14px; color: #4b4f52; }
.gp-total strong { font-size: clamp(28px, 5vw, 40px); color: #2d3138; }
.gp-total small { font-size: 13px; color: #6b7178; }
.gp-btn-checkout { min-width: min(420px, 100%); min-height: 52px; border: 0; border-radius: 12px; font-family: inherit; font-size: 17px; font-weight: 700; color: #fff; background: linear-gradient(135deg, var(--gp-accent), var(--gp-accent-2)); box-shadow: 0 8px 16px rgba(79,70,229,0.25); cursor: pointer; }
.gp-btn-checkout:disabled { opacity: 0.65; cursor: not-allowed; }
.gp-btn-assist { min-width: min(420px, 100%); min-height: 48px; display: inline-flex; align-items: center; justify-content: center; border-radius: 12px; border: 2px solid var(--gp-green-ink); color: var(--gp-green-ink); font-weight: 700; font-size: 15px; text-decoration: none; background: rgba(255,255,255,0.45); }
.gp-confirm { display: grid; gap: 8px; }
.gp-confirm-title { margin: 0; font-size: clamp(20px, 3vw, 28px); font-weight: 800; color: var(--gp-green-ink); }
.gp-confirm-body { margin: 0; font-size: 15px; color: #4b4f52; max-width: 460px; }

.gp-modal-backdrop { position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center; padding: 18px; background: rgba(0,0,0,0.76); }
.gp-modal { width: min(560px, 100%); background: #e5e5e6; border-radius: 16px; padding: 22px 18px; color: #4e5155; display: grid; gap: 14px; justify-items: center; text-align: center; max-height: calc(100vh - 36px); overflow: auto; }
.gp-modal-icon { width: 46px; height: 46px; }
.gp-modal-msg { margin: 0; font-size: clamp(16px, 2vw, 20px); line-height: 1.3; font-weight: 500; }
.gp-modal-preview { width: min(220px, 60vw); aspect-ratio: 3 / 5; object-fit: cover; border-radius: 12px; box-shadow: 0 6px 18px rgba(25,30,35,0.14); }
.gp-modal-actions { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; }

@keyframes gp-rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
@keyframes gp-spin { to { transform: rotate(360deg); } }
@keyframes gp-hint { 0%, 100% { transform: translateY(0); opacity: 0.92; } 50% { transform: translateY(5px); opacity: 1; } }

@media (max-width: 760px) {
  .gp-upload { grid-template-columns: 1fr; }
  .gp-preview { max-width: 320px; margin: 0 auto; height: 300px; }
  .gp-row { grid-template-columns: 1fr; gap: 6px; }
  .gp-readonly { justify-self: start; }
  .gp-split { grid-template-columns: 1fr; }
  .gp-actions-right { justify-content: stretch; }
  .gp-btn-primary { width: 100%; }
}
`;
