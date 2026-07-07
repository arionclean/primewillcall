# SMS via Twilio: booking confirmations and inbound replies

Port of the live Xano SMS flow (workspace PWC, id 6, branch v1) to Supabase + Next.js.
Xano stays untouched; this documents what exists there and what was reproduced here.

## How it works in Xano today

### Outbound: new booking -> SMS

1. Table trigger `City tour campaign_v1` (trigger id 30) fires on `bookings` insert when `phone != null`.
   The older `City tour campaign` (id 27) is `active = false`.
   - US numbers only ("phoneNumber classify by country").
   - If the phone has never received a message (`message_historial` count is 0), sends an intro:
     `Hi {Fname}, it's Jessi from {product_name}` with tag `optIn` (product name looked up in
     `products_variation`, defaulting to "Miami Skyline Cruises").
   - Always sends the confirmation:
     `Use this link to see your ticket and the meeting point information: https://bked.io/booking/{bookingConfirmation_id} (Text STOP to unsubscribe).`
     with tag `bookingConfirmation`.
2. Both messages go through function `send sms telnyxs` (fn 93). Despite the name, the Telnyx call
   is disabled; for US numbers it calls `communication/send sms v2` (fn 225) with from `8774608995`,
   which POSTs to `https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json` (Basic auth,
   form-encoded From/To/Body, expects HTTP 201).
3. Every send is logged by `add to message logs` (fn 95) into `message_historial` (direction,
   from, to, content, tag, costs) and linked to a `contacts` row by phone (creating an "unknown"
   contact if none exists). Errors trigger an internal notification.

Related endpoint: `POST /api:DgTgH3v8/sms/v1` (api id 660, Communication group) is the
authenticated generic send endpoint used by the apps; it calls the same `send sms telnyxs`.

### Inbound: customer replies -> webhook

The Twilio number's Messaging webhook points at
`POST /api:M7vqYZvJ/receive/sms_respose_twilio` (api id 788, brevo group, unauthenticated).
The older Telnyx handlers (`sms/v1/webhook`, api id 659, and `receive/sms_respose`, api id 548)
are dead code paths kept from the Telnyx era.

On `SmsStatus == "received"` it:

1. Logs the message via `add to message logs` (direction inbound, resolves contact by phone).
2. Sends an internal notification ("nuevo mensaje entrante ...").
3. Runs `analyze inbound message_v2` (fn 269):
   - Finds the contact's last outbound message; if one exists, cancels all pending `flowList`
     timers for the contact; if none, notifies "customer messaged without prior outbound".
   - If the last outbound tag was `rateAsk`/`rateAsk2`: classifies the reply 1-5 with OpenAI
     (gpt-4o-mini, JSON mode). Rating >= 5 creates `reviewly` + `unifiedReview` rows, schedules a
     24h `reviewHelp` timer, and sends a Google-review ask through a Make webhook. Under 5 sends
     an apology/feedback message. Unparseable replies just notify.
   - If the body contains "STOP": sends an unsubscribe confirmation and notifies.

## What was reproduced here

| Xano | This repo |
|---|---|
| `communication/send sms v2` (Twilio REST call) | [src/lib/sms/twilio.ts](../src/lib/sms/twilio.ts) `sendTwilioSms` |
| `send sms telnyxs` + `add to message logs` | [src/lib/sms/messages.ts](../src/lib/sms/messages.ts) `sendSms` (US-only, opt-out aware, logs to `sms_messages`) |
| `City tour campaign_v1` booking trigger | `sendBookingConfirmationSms` in the same module; call it after creating a booking |
| `POST sms/v1` (auth send) | [src/app/api/sms/send/route.ts](../src/app/api/sms/send/route.ts) (Supabase staff token) |
| `POST receive/sms_respose_twilio` | [src/app/api/webhooks/twilio/sms/route.ts](../src/app/api/webhooks/twilio/sms/route.ts) |
| `message_historial` table + contact linking | `sms_messages` table ([migration](../supabase/migrations/20260707170000_sms_messaging.sql)), auto-linked to `customers` by phone, with `business_id`/`booking_id`/`sent_by_staff_id` following the `whatsapp_messages` house style |
| STOP handling in `analyze inbound message_v2` | `sms_opt_outs` table + keyword handling in the webhook |

### Deliberate changes (not a 1:1 port)

- **Webhook signature validation.** The Xano endpoint is open; the new route verifies
  `X-Twilio-Signature` (HMAC-SHA1) and returns 403 otherwise.
- **Opt-outs are enforced before sending.** Xano only reacted to STOP after the fact; here
  `sendSms` skips opted-out numbers, and STOP/START keywords update `sms_opt_outs`. We do not
  send our own unsubscribe confirmation: Twilio's default opt-out handling already auto-replies
  and blocks the number, so the Xano behavior would fail with error 21610 anyway.
- **No sleeps.** The Xano flow has `util.sleep 5/10` workarounds; dropped.
- **Dead Telnyx branches dropped.** Only the live Twilio path was ported.
- **TwiML response.** The webhook replies with an empty `<Response/>` so Twilio does not log errors.

### Not yet ported (blocked on schema)

- Contact resolution/creation per message (needs the new `contacts` model).
- `analyze inbound message_v2` review funnel: rateAsk classification via LLM, `flowList` timers,
  `reviewly`/`unifiedReview`, Make webhooks. Marked as TODO in the webhook route.
- Internal push notifications on inbound messages.
- Scheduled sends (`schedule_sms` table + "send scheduled city tour campaign" task, currently
  disabled in Xano) and the `execute timers` task that drives `flowList`.

## Chat UI and Xano coexistence

The `/messages` page is a two-way SMS chat for merchants that runs alongside Xano
without touching it:

- **Inbound:** the Twilio number's webhook points at this app; the route logs the
  message and mirrors the exact payload to Xano's `receive/sms_respose_twilio`
  (`XANO_SMS_FORWARD_URL`, defaults to the live endpoint). Xano's notifications and
  reply handling keep working unchanged. Set the var to `""` at final cutover.
- **Outbound:** chat sends go straight to the Twilio REST API (tag `chat`); Xano is
  not involved.
- **History:** Twilio is the shared source of truth. `POST /api/sms/sync` pulls both
  directions from the Twilio Messages API (incremental, deduped by `twilio_sid`), so
  Xano-sent messages also appear in threads. The page runs a sync on load.
- **Live updates:** Supabase Realtime on `sms_messages` inserts (publication added in
  the migration); the conversation list comes from the `sms_conversations()` RPC
  (one aggregated row per customer number).
- **Access:** `/messages` requires a Supabase session for an active `staff` user
  (RLS mirrors `whatsapp_messages`: owners see everything, business staff see their
  business); `/login` is a minimal email/password sign-in. Sync is limited to
  owner/business_manager; sends record `sent_by_staff_id`.

Known coexistence caveat: Xano's reply analysis keys off the last outbound message in
its own log, so a chat reply sent here while Xano has a pending `rateAsk` can still be
interpreted by Xano as a rating.

## Setup

1. Apply the migration `20260707170000_sms_messaging.sql` to the Supabase project
   (`qbnizuhozzwkiitfkjee`).
2. Set the env vars from [.env.example](../.env.example) (Twilio SID/token/from number,
   `SUPABASE_SERVICE_ROLE_KEY`, `TWILIO_WEBHOOK_BASE_URL`, `XANO_SMS_FORWARD_URL`).
3. In the Twilio console, point the number's Messaging webhook ("A message comes in") to
   `https://<app-domain>/api/webhooks/twilio/sms` (HTTP POST). With forwarding enabled
   this is safe to do while Xano is still live; reverting is one console change.
