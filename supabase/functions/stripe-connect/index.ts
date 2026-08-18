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
// Every acct_ id written here comes from Stripe itself or from the business's own
// stripe_account_id_legacy. Nothing accepts a free-typed account id, so a caller can
// never point a business at an account it has never used.
//
// Secrets: STRIPE_SECRET_KEY (Prime's PLATFORM key), APP_URL. SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are provided by the platform.

import {
  accountFeesPayer,
  accountStatusColumns,
  appBaseUrl,
  connectControllerParams,
  getStripe,
  isFeeFreeAccount,
  STRIPE_META,
  stripeConfigured,
  stripeErrorMessage,
} from "../_shared/stripe.ts";
import { corsHeaders, db, json } from "../_shared/sms.ts";
import { requireStaff, type Staff } from "../_shared/staff-auth.ts";

type Action =
  | "status"
  | "create"
  | "onboarding_link"
  | "login_link"
  | "refresh"
  | "start_migration"
  | "switch_over"
  | "switch_back"
  | "cancel_migration";

/** Actions that change which account a business's money lands on. */
const OWNER_ONLY: ReadonlySet<Action> = new Set<Action>([
  "start_migration",
  "switch_over",
  "switch_back",
  "cancel_migration",
]);

interface Payload {
  action?: Action;
  business_id?: string;
  target?: "primary" | "pending";
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

Deno.serve(async (req) => {
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
      const accountId = payload.target === "pending"
        ? biz.stripe_account_id_pending
        : biz.stripe_account_id;
      if (!accountId) return json({ error: "This business has no Stripe account yet." }, 400);
      try {
        const link = await stripe.accounts.createLoginLink(accountId);
        return json({ url: link.url });
      } catch (err) {
        console.error("[stripe-connect] login link failed:", err);
        return json({ error: stripeErrorMessage(err) }, 502);
      }
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
     * Start moving a business off platform-paid Connect fees.
     *
     * Creates a SECOND account with the fee-free controller and parks it in
     * stripe_account_id_pending. The live account keeps taking every charge until
     * switch_over runs, so this is safe to call at any time. Calling it again while
     * a pending account exists re-links that one instead of creating another.
     */
    case "start_migration": {
      if (biz.stripe_account_id_pending) {
        return await onboardingLink(businessId, biz.stripe_account_id_pending);
      }
      if (!biz.stripe_account_id) {
        return json({ error: "Set up payments for this business first." }, 400);
      }
      if (isFeeFreeAccount(biz.stripe_fees_payer)) {
        return json({ error: "This business is already on fee-free pricing." }, 400);
      }
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
          metadata: {
            [STRIPE_META.businessId]: biz.id,
            migrated_from_account_id: biz.stripe_account_id,
          },
        });
        await db
          .from("businesses")
          .update({ stripe_account_id_pending: account.id })
          .eq("id", businessId);
        return await onboardingLink(businessId, account.id);
      } catch (err) {
        console.error("[stripe-connect] migration start failed:", err);
        return json({ error: stripeErrorMessage(err) }, 502);
      }
    }

    /**
     * Make the pending account the live one.
     *
     * Gated on charges_enabled so there is never a moment where the business points
     * at an account that cannot take money. The old account moves to the legacy list
     * rather than being forgotten: its balance still has to pay out, and refunds of
     * charges it took are routed by stripe_transactions.connected_account_id.
     */
    case "switch_over": {
      if (!biz.stripe_account_id_pending) {
        return json({ error: "There is no new account waiting to switch to." }, 400);
      }
      try {
        const account = await stripe.accounts.retrieve(biz.stripe_account_id_pending);
        if (!account.charges_enabled) {
          return json({
            error:
              "Stripe has not enabled charges on the new account yet. Finish onboarding first.",
          }, 400);
        }
        const legacy = [...(biz.stripe_account_id_legacy ?? [])];
        if (biz.stripe_account_id && !legacy.includes(biz.stripe_account_id)) {
          legacy.push(biz.stripe_account_id);
        }
        await db
          .from("businesses")
          .update({
            stripe_account_id: account.id,
            stripe_account_id_pending: null,
            stripe_account_id_legacy: legacy,
            ...accountStatusColumns(account),
          })
          .eq("id", businessId);
        return json({ ok: true });
      } catch (err) {
        console.error("[stripe-connect] switch over failed:", err);
        return json({ error: stripeErrorMessage(err) }, 502);
      }
    }

    /**
     * The undo for switch_over. Accepts ONLY an id already in this business's legacy
     * list, and the account being replaced takes the other one's place, so the two
     * can be swapped back and forth without the list drifting.
     */
    case "switch_back": {
      const accountId = (payload.account_id ?? "").trim();
      if (!accountId || !(biz.stripe_account_id_legacy ?? []).includes(accountId)) {
        return json({ error: "That is not one of this business's previous accounts." }, 400);
      }
      try {
        const account = await stripe.accounts.retrieve(accountId);
        if (!account.charges_enabled) {
          return json({
            error:
              "Stripe is not allowing charges on that account, so payments cannot go back to it.",
          }, 400);
        }
        const legacy = (biz.stripe_account_id_legacy ?? []).filter((id) => id !== accountId);
        if (biz.stripe_account_id && !legacy.includes(biz.stripe_account_id)) {
          legacy.push(biz.stripe_account_id);
        }
        await db
          .from("businesses")
          .update({
            stripe_account_id: account.id,
            stripe_account_id_legacy: legacy,
            ...accountStatusColumns(account),
          })
          .eq("id", businessId);
        return json({ ok: true });
      } catch (err) {
        console.error("[stripe-connect] switch back failed:", err);
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
});
