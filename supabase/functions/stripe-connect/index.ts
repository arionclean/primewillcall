// Stripe Connect account management. Supabase-native replacement for the Vercel
// server actions in src/app/(app)/admin/businesses/[id]/payments-actions.ts.
//
// One function, one `action` field, because these are all steps of a single screen:
// the Payments panel on /admin/businesses/[id]. Splitting them into nine deployments
// would buy nothing and cost nine cold starts.
//
// Deployed with JWT ON. The browser's supabase-js attaches the signed-in staff
// member's token, requireStaff turns it into their staff row, and each action
// re-checks the role before writing. Owner-only for anything that moves which
// account a business charges on; owner or that business's own manager for the rest.
//
// Every acct_ id written here comes from Stripe itself. Nothing accepts a free-typed
// account id, so a caller can never point a business at an account it has never used.
//
// Moving a business onto its new account (or back) is NOT here: it is internal, run by
// us from SQL through stripe-account-switch, never a button in the app.
//
// Secrets: STRIPE_SECRET_KEY (Prime's PLATFORM key), APP_URL, STRIPE_PUBLISHABLE_KEY
// (for Stripe's embedded bank form). SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
// provided by the platform.

import type Stripe from "npm:stripe@22.3.0";
import {
  accountFeesPayer,
  accountStatusColumns,
  appBaseUrl,
  connectControllerParams,
  dashboardOf,
  getStripe,
  STRIPE_META,
  STRIPE_DASHBOARD_URL,
  stripeConfigured,
  stripeErrorMessage,
} from "../_shared/stripe.ts";
import { employeeFromRequest, logStaffAction } from "../_shared/audit.ts";
import { corsHeaders, db, json } from "../_shared/sms.ts";
import { requireStaff, type Staff } from "../_shared/staff-auth.ts";
import { withSentry } from "../_shared/sentry.ts";

/**
 * The platform's PUBLISHABLE key (pk_live_...), handed to the browser with each
 * account session so Stripe's embedded form can load. Public by design; a function
 * secret only so every Stripe setting lives in one place.
 */
const STRIPE_PUBLISHABLE_KEY = Deno.env.get("STRIPE_PUBLISHABLE_KEY") ?? "";

type Action =
  | "status"
  | "accounts"
  | "create"
  | "onboarding_link"
  | "login_link"
  | "account_session"
  | "refresh"
  | "start_migration"
  | "cancel_migration";

/**
 * Actions that change which account a business's money lands on, or the bank it is
 * paid into (Stripe's account form can change the payout bank).
 */
const OWNER_ONLY: ReadonlySet<Action> = new Set<Action>([
  "account_session",
  "start_migration",
  "cancel_migration",
]);

interface Payload {
  action?: Action;
  business_id?: string;
  target?: "primary" | "pending";
  /** login_link and account_session: one of THIS business's accounts (current, waiting or retired). */
  account_id?: string;
}

interface BusinessRow {
  id: string;
  name: string;
  contact_email: string | null;
  stripe_account_id: string | null;
  stripe_account_id_pending: string | null;
  stripe_account_id_legacy: string[] | null;
  stripe_fees_payer: string | null;
}

const BUSINESS_COLUMNS =
  "id, name, contact_email, stripe_account_id, stripe_account_id_pending, stripe_account_id_legacy, stripe_fees_payer";

function allowed(staff: Staff, businessId: string, action: Action): boolean {
  if (staff.role === "owner") return true;
  if (OWNER_ONLY.has(action)) return false;
  return staff.role === "business_manager" && staff.business_id === businessId;
}

/** Every account this business has had: in use, waiting, retired. */
function ownAccountIds(biz: BusinessRow): string[] {
  return [
    biz.stripe_account_id,
    biz.stripe_account_id_pending,
    ...(biz.stripe_account_id_legacy ?? []),
  ].filter((id): id is string => Boolean(id));
}

/**
 * The bank an account pays out to, and whether Stripe has stopped paying into it. A
 * payout the bank sends back (closed account, wrong numbers, a bank that refuses
 * Stripe) marks it `errored`, and Stripe sends nothing more there until the business
 * enters the bank again. Only the business can do that: it is not a requirement, so it
 * never shows in `requirements.currently_due`, and an onboarding link (outstanding
 * requirements only) does not offer it. An account with a Stripe login fixes it there;
 * one with none uses Stripe's embedded account form (`account_session`).
 */
async function payoutBank(
  stripe: Stripe,
  account: Stripe.Account,
): Promise<{ last4: string; rejected: boolean } | null> {
  try {
    const listed = account.external_accounts?.data ??
      (await stripe.accounts.listExternalAccounts(account.id, { limit: 10 })).data;
    const banks = listed.filter((x) => x.object === "bank_account");
    const bank = banks.find((b) => b.default_for_currency) ?? banks[0];
    if (!bank || bank.object !== "bank_account") return null;
    return {
      last4: bank.last4,
      rejected: bank.status === "errored" || bank.status === "verification_failed",
    };
  } catch (err) {
    console.error(`[stripe-connect] bank read failed for ${account.id}:`, err);
    return null;
  }
}

async function loadBusiness(businessId: string): Promise<BusinessRow | null> {
  const { data } = await db
    .from("businesses")
    .select(BUSINESS_COLUMNS)
    .eq("id", businessId)
    .maybeSingle();
  return (data as BusinessRow | null) ?? null;
}

/** Hosted onboarding link, used both for first setup and for fixing requirements. */
async function onboardingLink(businessId: string, accountId: string): Promise<Response> {
  const stripe = getStripe()!;
  const base = appBaseUrl();
  if (!base) return json({ error: "Payment setup is not available right now." }, 503);

  try {
    const link = await stripe.accountLinks.create({
      account: accountId,
      type: "account_onboarding",
      refresh_url: `${base}/admin/businesses/${businessId}?stripe=refresh`,
      return_url: `${base}/admin/businesses/${businessId}?stripe=return`,
      collection_options: { fields: "eventually_due" },
    });
    return json({ url: link.url });
  } catch (err) {
    console.error("[stripe-connect] onboarding link failed:", err);
    return json({ error: stripeErrorMessage(err) }, 502);
  }
}

Deno.serve(withSentry("stripe-connect", async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const auth = await requireStaff(req);
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const action = payload.action;
  const businessId = payload.business_id;
  if (!action || !businessId) {
    return json({ error: "action and business_id are required" }, 400);
  }
  if (!allowed(auth.staff, businessId, action)) {
    return json({ error: "Not authorized." }, 403);
  }

  // `status` is the panel's bootstrap call, so it answers even with no key set:
  // that is how the UI learns to show "not switched on for the platform yet".
  if (!stripeConfigured()) {
    if (action === "status") return json({ configured: false, pending: null });
    return json({ error: "Payments are not configured yet." }, 503);
  }
  const stripe = getStripe()!;

  const biz = await loadBusiness(businessId);
  if (!biz) return json({ error: "Business not found." }, 404);

  switch (action) {
    /**
     * Whether Stripe is usable, plus the live state of a pending account.
     *
     * The pending account exists only during a migration, so its status is read
     * from Stripe on demand rather than mirrored into columns that would sit NULL
     * on every other business.
     */
    case "status": {
      if (!biz.stripe_account_id_pending) return json({ configured: true, pending: null });
      try {
        const account = await stripe.accounts.retrieve(biz.stripe_account_id_pending);
        return json({
          configured: true,
          pending: {
            id: account.id,
            chargesEnabled: Boolean(account.charges_enabled),
            detailsSubmitted: Boolean(account.details_submitted),
            requirementsDue: account.requirements?.currently_due?.length ?? 0,
          },
        });
      } catch (err) {
        // A pending account that cannot be read is not a broken page. Report it as
        // not-ready and let the panel keep working.
        console.error("[stripe-connect] pending account read failed:", err);
        return json({
          configured: true,
          pending: {
            id: biz.stripe_account_id_pending,
            chargesEnabled: false,
            detailsSubmitted: false,
            requirementsDue: 0,
          },
        });
      }
    }

    /** First setup: create the account if missing, then hand off to Stripe. */
    case "create": {
      if (!biz.stripe_account_id) {
        try {
          const account = await stripe.accounts.create({
            controller: connectControllerParams(),
            country: "US",
            email: biz.contact_email ?? undefined,
            business_profile: { name: biz.name },
            capabilities: {
              card_payments: { requested: true },
              transfers: { requested: true },
            },
            metadata: { [STRIPE_META.businessId]: biz.id },
          });
          await db
            .from("businesses")
            .update({
              stripe_account_id: account.id,
              stripe_fees_payer: accountFeesPayer(account),
            })
            .eq("id", businessId);
          return await onboardingLink(businessId, account.id);
        } catch (err) {
          console.error("[stripe-connect] account create failed:", err);
          return json({ error: stripeErrorMessage(err) }, 502);
        }
      }
      return await onboardingLink(businessId, biz.stripe_account_id);
    }

    case "onboarding_link": {
      const accountId = payload.target === "pending"
        ? biz.stripe_account_id_pending
        : biz.stripe_account_id;
      if (!accountId) return json({ error: "This business has no Stripe account yet." }, 400);
      return await onboardingLink(businessId, accountId);
    }

    case "login_link": {
      // A sale taken before the business was moved to a new account (and a dispute on
      // it) lives on the account it was taken on, so a link can ask for that one. Only
      // this business's own accounts are accepted.
      if (payload.account_id && !ownAccountIds(biz).includes(payload.account_id)) {
        return json({ error: "That is not one of this business's Stripe accounts." }, 400);
      }
      const accountId = payload.account_id ||
        (payload.target === "pending" ? biz.stripe_account_id_pending : biz.stripe_account_id);
      if (!accountId) return json({ error: "This business has no Stripe account yet." }, 400);
      try {
        // Only an Express account has a login link. The owner of a full-dashboard
        // account signs in to Stripe with their own login, and an account with no
        // dashboard has nothing to open: asking Stripe for a link anyway is a 400,
        // which came back as a 502 and raised an alert on every click. With no url
        // the button opens the account in Prime's own dashboard instead.
        const account = await stripe.accounts.retrieve(accountId);
        const dashboard = dashboardOf(account);
        if (dashboard === "full") return json({ url: STRIPE_DASHBOARD_URL });
        if (dashboard === "none") return json({ url: null });
        const link = await stripe.accounts.createLoginLink(accountId);
        return json({ url: link.url });
      } catch (err) {
        console.error("[stripe-connect] login link failed:", err);
        return json({ error: stripeErrorMessage(err) }, 502);
      }
    }

    /**
     * Stripe's own account form (the embedded "account management" component) for one
     * of this business's accounts: the only way an account with no Stripe login can
     * change its payout bank. Onboarding links collect only what is missing, update
     * links are refused when Stripe collects requirements, and Stripe's docs say such
     * an account "must use embedded components". Stripe signs the account's own
     * contact in with a code before it shows the bank, and that cannot be turned off
     * while Stripe collects requirements. Owner only (see OWNER_ONLY), and recorded.
     */
    case "account_session": {
      const accountId = payload.account_id;
      if (!accountId || !ownAccountIds(biz).includes(accountId)) {
        return json({ error: "That is not one of this business's Stripe accounts." }, 400);
      }
      if (!STRIPE_PUBLISHABLE_KEY) {
        return json({ error: "Stripe's form is not available right now." }, 503);
      }
      try {
        const session = await stripe.accountSessions.create({
          account: accountId,
          components: {
            account_management: {
              enabled: true,
              features: { external_account_collection: true },
            },
          },
        });
        await logStaffAction(db, {
          staffId: auth.staff.id,
          businessId,
          employee: await employeeFromRequest(db, req),
          entity: "stripe_accounts",
          entityId: accountId,
          action: "opened_bank_form",
        });
        return json({ client_secret: session.client_secret, publishable_key: STRIPE_PUBLISHABLE_KEY });
      } catch (err) {
        // Stripe's own wording here can name the key it was refused for: log it, and
        // tell the owner something plain.
        console.error("[stripe-connect] account session failed:", err);
        return json({ error: "Stripe's form could not be opened. Try again in a moment." }, 502);
      }
    }

    /**
     * Every Stripe account this business has: the one in use, one waiting for a
     * switch, and the ones it used before. Each is read from Stripe, so which login
     * it has, and whether Stripe has finished setting it up, is Stripe's answer. One
     * that cannot be read keeps its row, with the reason, instead of hiding the others.
     */
    case "accounts": {
      const rows: { id: string; role: "current" | "waiting" | "previous" }[] = [];
      const add = (id: string | null, role: "current" | "waiting" | "previous") => {
        if (id && !rows.some((r) => r.id === id)) rows.push({ id, role });
      };
      add(biz.stripe_account_id, "current");
      add(biz.stripe_account_id_pending, "waiting");
      for (const id of biz.stripe_account_id_legacy ?? []) add(id, "previous");

      const accounts = await Promise.all(rows.map(async (row) => {
        try {
          const account = await stripe.accounts.retrieve(row.id);
          return {
            ...row,
            dashboard: dashboardOf(account),
            opened: account.created ? new Date(account.created * 1000).toISOString() : null,
            detailsSubmitted: Boolean(account.details_submitted),
            chargesEnabled: Boolean(account.charges_enabled),
            requirementsDue: account.requirements?.currently_due?.length ?? 0,
            bank: await payoutBank(stripe, account),
            error: null,
          };
        } catch (err) {
          console.error(`[stripe-connect] account read failed for ${row.id}:`, err);
          return {
            ...row,
            dashboard: null,
            opened: null,
            detailsSubmitted: false,
            chargesEnabled: false,
            requirementsDue: 0,
            bank: null,
            error: stripeErrorMessage(err),
          };
        }
      }));
      return json({ accounts });
    }

    /** Pull the live account state into the businesses row. */
    case "refresh": {
      if (!biz.stripe_account_id) {
        return json({ error: "This business has no Stripe account yet." }, 400);
      }
      try {
        const account = await stripe.accounts.retrieve(biz.stripe_account_id);
        await db.from("businesses").update(accountStatusColumns(account)).eq("id", businessId);
        return json({ ok: true });
      } catch (err) {
        console.error("[stripe-connect] refresh failed:", err);
        return json({ error: stripeErrorMessage(err) }, 502);
      }
    }

    /**
     * Start moving a business onto a Standard account: its own Stripe login, and
     * Stripe's fees billed to the business, not Prime.
     *
     * Creates a SECOND account (connectControllerParams) and parks it in
     * stripe_account_id_pending. The live account keeps taking every charge until we
     * switch the business over (stripe-account-switch), so this is safe to call at any
     * time. The owner starts it from Add Stripe account on the business page.
     *
     * A waiting Standard account is re-linked, never doubled. A waiting account with no
     * Stripe login (made 2026-08-19 to 2026-10-26, Skyline's and Jet Ski's) is set aside
     * into stripe_account_id_legacy, so its money and history still show with the
     * business, and a Standard one takes its place.
     */
    case "start_migration": {
      if (!biz.stripe_account_id) {
        return json({ error: "Set up payments for this business first." }, 400);
      }
      try {
        // A business already on a Standard account has nothing to move to. One on the
        // no-login kind (Key West since 2026-10-14) does: same fees, plus its login.
        const current = await stripe.accounts.retrieve(biz.stripe_account_id);
        if (dashboardOf(current) === "full") {
          return json({ error: "This business already has its own Stripe login." }, 400);
        }
        const legacy = [...(biz.stripe_account_id_legacy ?? [])];
        if (biz.stripe_account_id_pending) {
          const waiting = await stripe.accounts.retrieve(biz.stripe_account_id_pending);
          if (dashboardOf(waiting) === "full") return await onboardingLink(businessId, waiting.id);
          if (!legacy.includes(waiting.id)) legacy.push(waiting.id);
        }
        const account = await stripe.accounts.create({
          controller: connectControllerParams(),
          country: "US",
          email: biz.contact_email ?? undefined,
          business_profile: { name: biz.name },
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
          },
          metadata: {
            [STRIPE_META.businessId]: biz.id,
            migrated_from_account_id: biz.stripe_account_id,
          },
        });
        await db
          .from("businesses")
          .update({ stripe_account_id_pending: account.id, stripe_account_id_legacy: legacy })
          .eq("id", businessId);
        return await onboardingLink(businessId, account.id);
      } catch (err) {
        console.error("[stripe-connect] migration start failed:", err);
        return json({ error: stripeErrorMessage(err) }, 502);
      }
    }

    /**
     * Forget the pending account. The Stripe account is left alone: an un-onboarded
     * account costs nothing, and deleting it would throw away whatever the business
     * already filled in.
     */
    case "cancel_migration": {
      await db
        .from("businesses")
        .update({ stripe_account_id_pending: null })
        .eq("id", businessId);
      return json({ ok: true });
    }

    default:
      return json({ error: "Unknown action" }, 400);
  }
}));
