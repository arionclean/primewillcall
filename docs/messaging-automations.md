# Messaging automations (with waits)

Owner-built rules that text customers automatically when a booking comes in. Edited at
`/admin/messaging` (Automations tab). This doc covers the data model, the "wait" delivery
path, and the checklist to make it actually send in production.

## The model

An **automation** is a **trigger** plus one or more **actions**:

- **Identity**: `messaging_rules.automation_id`. Rows sharing this id are one automation.
  This is what lets two automations share the same trigger and product without merging
  (added in `20260712120000_messaging_rules_automation_id.sql`; backfilled by the old
  trigger+product grouping). Creating a message with no `automation_id` starts a new
  automation (the column default mints a fresh id); "Add action" passes the existing id.
- **Trigger**: `trigger_event` (`new_booking` or `new_booking_non_us`, see "US vs
  non US" below) + `business_tour_ids` (a
  `uuid[]` of products; `null` or empty = any product). Multi-select, so one automation can
  cover three products and skip the rest, which the old single `business_tour_id` column
  could not express (replaced in `20260818120000_messaging_rules_multi_product.sql`, which
  backfilled each single id into a one-element array). Shared across an automation's rows;
  changing the products moves them all (scoped by `automation_id`, so it never merges two
  automations). Matching happens in code, not in the query: "empty set OR contains this
  product" does not express cleanly as a PostgREST array filter, and the rule set is a
  handful of rows. An array carries no foreign key, so a deleted product leaves a dead id
  behind; it simply stops matching, and the picker only renders ids it can still resolve.
- **Action**: a single `messaging_rules` row (a message). Each has a `channel`
  (`sms` / `whatsapp`), the body or WhatsApp template, `only_first_contact`, `is_active`,
  and `delay_minutes`. Messages have no user-facing name; the row's `name` is auto-derived
  for storage and the UI shows the message content.

### US vs non US (`new_booking` / `new_booking_non_us`)

The two booking triggers split on the customer's phone and are **exclusive**:
`run-booking-automations` classifies the number once (`classifyPhone` in
`supabase/functions/_shared/phone.ts`) and queries rules for exactly one of them, so a
guest never collects both sets of messages and the owner never has to add an "unless"
anywhere.

They are separate triggers rather than one trigger with a condition because an overseas
guest usually needs a *different* message, not the same one: WhatsApp instead of SMS,
no US reply instructions, and often fewer follow-ups given what international SMS costs.
Written as two automations, each side is edited on its own in the same builder.

**"US" means the +1 country code**, which is all a phone number can answer on its own,
so Canada and the Caribbean count as US here. That matches what Twilio treats as
domestic, which is the thing the split is really about.

`new_booking` keeps its exact former meaning and is simply worded honestly now, "A new
booking comes in from a US phone". Before this trigger existed the runner normalized with
a US-only helper, so an overseas number resolved to `NULL` and the run stopped at "no
customer phone" before a single rule was read: `new_booking` could only ever reach a US
number. The label was the inaccurate half, not the behaviour, so every automation built
before the split behaves identically after it.

There is deliberately no third "any phone" trigger. It would have to fire alongside one
of the other two, which is how a guest ends up with two confirmations, and the owner
would have no way to see that from the cards.

**What counts as reachable.** `classifyPhone` returns `null` (send nothing) unless it can
place the number without guessing:

| Stored value | Result |
| --- | --- |
| `7865551234`, `(305) 555-1234`, `+13055551234` | US, `+13055551234` |
| `+34 607 96 05 85`, `(+44)1803225485` | non US, `+34607960585` / `+441803225485` |
| `0031610501406` (the `00` international prefix) | non US, `+31610501406` |
| `306947705650` (bare digits, no country code marker) | refused |
| `0211276116` (a New Zealand mobile stored as 10 digits) | refused |
| `N/A`, `6`, `1852468624995504` | refused |

A number is only read as international when its country code is **explicit**, a leading
`+` or the `00` access prefix. Bare non-US-shaped digits are refused rather than guessed,
because prefixing `+` to a national number that dropped its country code invents a
different number, and a guessed number is someone else's phone. The cost of that
strictness is ~3.2k legacy rows that could theoretically be reached but are not; all of
them are Xano-synced, which never fire automations anyway.

**Waits**: the builder treats an automation as a SEQUENCE. A Wait node is the gap
between the previous step and the next message ("wait 1 day, then continue"); editing a
gap shifts that message and every step after it. Storage stays absolute:
`messaging_rules.delay_minutes` is each message's total delay from the trigger (the sum
of the gaps above it, 0 = immediately, max 30 days = `43200`), because that is what the
send queue schedules on. `updateWaitGapAction` does the gap-to-absolute math.

## How firing works (DB-triggered, page-independent)

Firing lives in the **database**, not in app code, so it works for a booking from ANY
source, not just whichever page remembered to call it. Everything funnels through one
queue and one sender, and that sender enforces a hard spend cap.

1. A booking row is inserted. An `AFTER INSERT` trigger on `bookings`,
   `WHEN (NEW.legacy_id IS NULL)`, runs `on_native_booking_created()`. The `legacy_id IS
   NULL` clause means it fires only for **Supabase-native** bookings and **never** for the
   ~90k Xano-synced rows (which still have Xano do their texting). It also no-ops unless
   `messaging_settings.automations_enabled` is true.
2. The trigger `pg_net`-POSTs the booking id to the **`run-booking-automations`** edge
   function (enqueue only, never calls Twilio). It matches the active rules for the
   product, renders each, and inserts rows into `public.scheduled_messages`
   (`send_at = now + delay_minutes`, immediate = `now`). Idempotent per booking.
3. `pg_cron` calls **`dispatch-scheduled-messages`** every minute. It enforces the
   **global hourly cap** (see below), `claim_due_scheduled_messages()` up to the remaining
   budget (atomic `FOR UPDATE SKIP LOCKED`), sends via Twilio, marks `sent` / `failed`.

The old inline path (`maybeRunNewBookingRules` in `src/lib/sms/rules.ts`, called from
`/schedule`) is **retired** — it bypassed the cap and would double-send alongside the
trigger. `rules.ts` is kept only as the reference the edge function was ported from.

## Guardrails (money safety)

`public.messaging_settings` (single row) is the control panel; everything defaults to safe:

- `automations_enabled` (default **false**) — the master kill switch. Off = the trigger
  does nothing and nothing is enqueued.
- `sms_hourly_cap` (default **100**) — the dispatcher never sends more than this many
  messages per rolling hour, globally. Overflow stays `pending` (delayed, **not dropped**)
  and drains on later runs. This makes a runaway spend impossible regardless of how many
  bookings flood in.
- Alerts — when the cap actively throttles work, the dispatcher logs a
  `public.messaging_alerts` row and notifies, naming the top products/sources filling the
  queue (deduped to once per hour):
  - `alert_email` (primary) — emailed via **Resend** from `alert_email_from` (must be a
    Resend-verified domain; we use `alerts@alert.primewillcall.com`). Needs the
    `RESEND_API_KEY` function secret. Verified end to end 2026-07-12 (cap=0 dry run).
  - `alert_phone` (optional) — SMS via Twilio, if set.
- `booking_link_base` — base for `{{booking_link}}` (set to the app's `/booking`).

To turn automations on: set `messaging_settings.automations_enabled = true`, make sure
`run-booking-automations` has the `CRON_SECRET` function secret (same value as the
dispatcher), and set `alert_phone`. Migration:
`supabase/migrations/20260712140000_booking_automations_guardrails.sql`. Queue tables/RPC:
`supabase/migrations/20260711120000_scheduled_messages.sql`.

## Go-live checklist

Status on project `qbnizuhozzwkiitfkjee` (as of 2026-07-12):

- [x] Schema migrations applied (`scheduled_messages`, `delay_minutes`, `automation_id`).
- [x] Dispatcher edge function `dispatch-scheduled-messages` deployed and ACTIVE (JWT off).
- [x] `pg_cron` + `pg_net` enabled; `CRON_SECRET` in Vault (`dispatch_cron_secret`); the
      every-minute cron job is scheduled and active.
- [x] Edge-function secrets set (`CRON_SECRET` + the four Twilio values) and **verified
      end to end**: a test row queued to a real number was sent (cron -> function 200 ->
      Twilio `SM...` SID -> row `sent`).
- [ ] **Wire the Groupon path** (step 4 below).
- [ ] **Flip `MESSAGING_AUTOMATIONS_ENABLED=true`** on the Next app (step 5).

Remaining steps to turn sending on:

1. **Twilio env on the Next app** (Vercel), for the *inline* (delay 0) sends:
   `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TWILIO_WHATSAPP_FROM`,
   and `BOOKING_LINK_BASE_URL` (set to `https://<app-domain>/booking`, not the bked.io
   default, so ticket links hit the new app's page).
2. ~~Deploy the dispatcher~~ (done). To redeploy after code changes:
   `supabase functions deploy dispatch-scheduled-messages --no-verify-jwt`. Its secrets
   (`TWILIO_*`, `CRON_SECRET`) are set on the function; the cron reads `CRON_SECRET` from Vault.
3. ~~Schedule the cron~~ (done; SQL kept below for reference / disaster recovery).
4. **Wire the other booking path**: add the same `maybeRunNewBookingRules({...})` call after
   the booking insert in `supabase/functions/gp-book/index.ts` (the internal `/schedule` flow is
   already wired in `src/app/(app)/schedule/actions.ts`). Until then, Groupon (`/gp`)
   bookings never enqueue or fire any automation.
5. **Flip it on**: set `MESSAGING_AUTOMATIONS_ENABLED=true` on the Next app — but only once
   Xano no longer sends the same booking texts, or customers get double-messaged.

### pg_cron SQL (step 3)

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Same value as the edge function's CRON_SECRET.
select vault.create_secret('<CRON_SECRET>', 'dispatch_cron_secret');

select cron.schedule(
  'dispatch-scheduled-messages',
  '* * * * *',
  $$
    select net.http_post(
      url := 'https://qbnizuhozzwkiitfkjee.supabase.co/functions/v1/dispatch-scheduled-messages',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'dispatch_cron_secret')
      ),
      body := '{}'::jsonb
    );
  $$
);
```

## Known gaps / follow-ups

- **Delayed sends are not yet mirrored into `sms_messages`**, so they will not appear in the
  Messages inbox and do not count toward the "first time we ever texted this number" check
  (that check runs at enqueue time). Immediate sends still log normally.
- **No retry**: a failed dispatch is marked `failed`, not retried. Add an attempts-based
  requeue if Twilio flakiness becomes an issue.
- **`only_first_contact` is evaluated at enqueue time**, not at send time.
- **International SMS needs Twilio geo permissions.** Twilio blocks SMS to a country
  until that country is enabled under Messaging > Geo permissions, and prices per
  country. A `new_booking_non_us` automation that looks correct will still fail at
  dispatch until the destination countries are switched on. WhatsApp does not have this
  restriction, which is one more reason it is usually the right channel for that trigger.
- **The app cannot yet capture a non-US number.** `PhoneInput`, `/schedule` and `/gp`
  all mask to 10 US digits, so today the only overseas numbers in the book arrive from
  the Xano sync and OTA email parsing. The trigger is correct and ready, but staff cannot
  key an international guest in by hand until the input side grows a country code.
