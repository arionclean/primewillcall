// Move a business onto another of its Stripe accounts: the new fee-free one waiting in
// stripe_account_id_pending, or back to one in stripe_account_id_legacy.
//
// INTERNAL. There is no button for this in the app, on purpose (2026-10-13): we run it,
// when the business's desks are closed, because a business with iPads has to restart the
// app and reconnect its card readers afterwards. Called from SQL with the cron secret,
// like the sweeps (docs/stripe-fee-free-accounts.md has the exact statement):
//
//   select net.http_post(
//     url := 'https://qbnizuhozzwkiitfkjee.supabase.co/functions/v1/stripe-account-switch',
//     headers := jsonb_build_object('Content-Type', 'application/json',
//       'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets
//                         where name = 'dispatch_cron_secret')),
//     body := jsonb_build_object('business_id', '<uuid>', 'dry_run', true),
//     timeout_milliseconds := 30000);
//
// Body: { business_id, account_id?, dry_run? }. Without account_id it switches to the
// pending account; with one it switches back to that previous account, which must be in
// this business's legacy list. dry_run answers with what would happen and changes
// nothing, in Stripe or here.
//
// In this order, so a failure never leaves a business half switched:
//   1. Stripe must report charges enabled on the target account.
//   2. Every kiosk of the business gets a card reader Location on the target account
//      (kiosk_terminal_locations), copied from its Location on the current one. A
//      Location belongs to one account, and kiosk-connection-token hands each tablet the
//      one for the account its business charges on, so these rows do nothing until 3.
//   3. One businesses row update moves the money. The old id goes to the legacy list:
//      its balance still pays out, and refunds and disputes of its charges are routed by
//      the account they settled on.
//
// Auth: x-cron-secret = CRON_SECRET. Secrets: STRIPE_SECRET_KEY (Prime's PLATFORM key).

import type Stripe from "npm:stripe@22.3.0";

import { accountStatusColumns, getStripe, stripeErrorMessage } from "../_shared/stripe.ts";
import { db, json } from "../_shared/sms.ts";
import { withSentry } from "../_shared/sentry.ts";

const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

type ReaderStep = {
  kiosk: string;
  /** The Location the kiosk's readers use now. Null: no reader, nothing to move. */
  from: string | null;
  /** Its Location on the target account, once made. */
  to: string | null;
  /** True when this run made (or, in a dry run, would make) a new Location for it. */
  created: boolean;
};

/**
 * Give each of the business's kiosks a card reader Location on `toAccount`, copying the
 * name and address of its Location on `fromAccount`. Kiosks sharing a Location there
 * share the copy. A kiosk that already has one on `toAccount` keeps it, so a second run
 * changes nothing, and the create carries an idempotency key, so a retry after a run
 * that failed halfway gets the same Location back instead of a second one. Kiosks with
 * their own account (kiosks.stripe_account_id) do not follow the business and are left
 * out. Throws on any failure.
 */
async function moveReaders(
  stripe: Stripe,
  businessId: string,
  fromAccount: string,
  toAccount: string,
  dryRun: boolean,
): Promise<ReaderStep[]> {
  const { data, error } = await db
    .from("kiosks")
    .select("id, slug, kiosk_terminal_locations(stripe_account_id, location_id)")
    .eq("business_id", businessId)
    .is("stripe_account_id", null)
    .order("slug");
  if (error) throw new Error(error.message);

  const kiosks = (data ?? []).map((k) => {
    const rows = (k.kiosk_terminal_locations ?? []) as { stripe_account_id: string; location_id: string }[];
    return {
      id: k.id as string,
      slug: (k.slug as string | null) ?? (k.id as string),
      from: rows.find((r) => r.stripe_account_id === fromAccount)?.location_id ?? null,
      to: rows.find((r) => r.stripe_account_id === toAccount)?.location_id ?? null,
    };
  });

  // Old Location -> its copy, seeded from kiosks already done so a sibling reuses it.
  const copies = new Map<string, string>();
  for (const k of kiosks) if (k.from && k.to) copies.set(k.from, k.to);

  const steps: ReaderStep[] = [];
  for (const k of kiosks) {
    if (k.to || !k.from) {
      steps.push({ kiosk: k.slug, from: k.from, to: k.to, created: false });
      continue;
    }
    let copy = copies.get(k.from) ?? null;
    let created = false;
    if (!copy) {
      // Read even in a dry run: a Location deleted in Stripe should show up now.
      const old = await stripe.terminal.locations.retrieve(k.from, {}, { stripeAccount: fromAccount });
      if ("deleted" in old && old.deleted) {
        throw new Error(`${k.slug}'s card reader location ${k.from} was deleted in Stripe.`);
      }
      created = true;
      if (!dryRun) {
        const { display_name, address } = old as Stripe.Terminal.Location;
        const made = await stripe.terminal.locations.create(
          {
            display_name,
            // A blank field is left out, not sent empty: Stripe reads "" as "unset this"
            // and refuses it (Key West's line2 is blank, 2026-10-14).
            address: {
              line1: address.line1 || undefined,
              line2: address.line2 || undefined,
              city: address.city || undefined,
              state: address.state || undefined,
              postal_code: address.postal_code || undefined,
              country: address.country || "US",
            },
          },
          { stripeAccount: toAccount, idempotencyKey: `kiosk-location:${k.from}:${toAccount}` },
        );
        copy = made.id;
        copies.set(k.from, copy);
      }
    }
    if (!dryRun && copy) {
      const { error: insertError } = await db
        .from("kiosk_terminal_locations")
        .insert({ kiosk_id: k.id, stripe_account_id: toAccount, location_id: copy });
      if (insertError) throw new Error(insertError.message);
    }
    steps.push({ kiosk: k.slug, from: k.from, to: copy, created });
  }
  return steps;
}

Deno.serve(withSentry("stripe-account-switch", async (req) => {
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const stripe = getStripe();
  if (!stripe) return json({ error: "Stripe is not configured." }, 503);

  let body: { business_id?: string; account_id?: string; dry_run?: boolean };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const businessId = String(body.business_id ?? "").trim();
  const backTo = String(body.account_id ?? "").trim();
  const dryRun = body.dry_run === true;
  if (!businessId) return json({ error: "business_id is required" }, 400);

  const { data: biz } = await db
    .from("businesses")
    .select("id, name, stripe_account_id, stripe_account_id_pending, stripe_account_id_legacy")
    .eq("id", businessId)
    .maybeSingle();
  if (!biz) return json({ error: "No such business." }, 404);

  const from = biz.stripe_account_id as string | null;
  const legacyList = (biz.stripe_account_id_legacy as string[] | null) ?? [];
  if (!from) return json({ error: "This business has no Stripe account to switch from." }, 400);
  if (backTo && !legacyList.includes(backTo)) {
    return json({ error: "That is not one of this business's previous accounts." }, 400);
  }
  const to = backTo || (biz.stripe_account_id_pending as string | null);
  if (!to) return json({ error: "There is no new account waiting to switch to." }, 400);

  try {
    const account = await stripe.accounts.retrieve(to);
    if (!account.charges_enabled) {
      return json({ error: "Stripe has not enabled charges on that account, so nothing was switched." }, 400);
    }

    const readers = await moveReaders(stripe, biz.id as string, from, to, dryRun);
    if (dryRun) return json({ dry_run: true, business: biz.name, from, to, readers });

    const legacy = legacyList.filter((id) => id !== to);
    if (!legacy.includes(from)) legacy.push(from);
    const { error } = await db
      .from("businesses")
      .update({
        stripe_account_id: to,
        // A switch back leaves a waiting new account where it is.
        stripe_account_id_pending: backTo ? biz.stripe_account_id_pending : null,
        stripe_account_id_legacy: legacy,
        ...accountStatusColumns(account),
      })
      .eq("id", biz.id);
    if (error) throw new Error(error.message);

    console.log(`[stripe-account-switch] ${biz.name} switched ${from} -> ${to}`);
    return json({ ok: true, business: biz.name, from, to, readers });
  } catch (err) {
    console.error("[stripe-account-switch] failed:", err);
    return json({ error: `Nothing was switched. ${stripeErrorMessage(err)}` }, 502);
  }
}));
