# SMS migration checklist (Twilio: Xano -> Supabase)

Status and remaining work for moving SMS off Xano. Background and architecture:
[sms-twilio.md](sms-twilio.md).

## Already done

- [x] `sms_messages` / `sms_opt_outs` tables, RLS, realtime, `sms_conversations()` RPC (applied to Supabase)
- [x] Outbound send + inbound webhook + history sync, live and deployed
- [x] Chat UI at `/messages` with realtime updates
- [x] Booking automations: the `on_native_booking_created` trigger calls
      `run-booking-automations` (enqueue only), and `dispatch-scheduled-messages` sends
      under a global hourly cap. `messaging_settings.automations_enabled` is ON.
- [x] **Sending, syncing and inbound handling all run in Supabase edge functions**
      (2026-08-16). Vercel still needs `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` for two
      things: the inbound route until Twilio is repointed (signature check), and
      `/admin/messaging` listing WhatsApp content templates (`src/lib/sms/twilio-content.ts`).
      | Was (Vercel) | Now (Supabase) |
      |---|---|
      | `POST /api/sms/send` | `sms-send` (JWT on, resolves caller's staff row) |
      | `POST /api/sms/sync` | `sms-sync` (JWT on, owner + business_manager) |
      | `POST /api/webhooks/twilio/sms` | `twilio-inbound-sms` (JWT off, X-Twilio-Signature is the auth) |
      | `src/lib/sms/{messages,twilio,sync}.ts` | `supabase/functions/_shared/sms.ts` |
      | `src/lib/sms/rules.ts` (never wired up) | `run-booking-automations` edge function |

## Remaining: point Twilio at Supabase

The inbound webhook still arrives at the **Vercel** route; the edge function is deployed
and tested but receives nothing until the console is changed. Both behave identically
(same logging, STOP/START, Xano mirroring, review branch), so this is a URL swap.

- [ ] In Twilio (number 877-460-8995, Messaging, "A message comes in"): save the current
      URL for rollback, then set
      `https://qbnizuhozzwkiitfkjee.supabase.co/functions/v1/twilio-inbound-sms` (HTTP POST)
- [ ] Confirm: text the number, a row appears in `sms_messages` within seconds, and Xano
      still reacts (the mirror is preserved)
- [ ] Then delete `src/app/api/webhooks/twilio/sms/route.ts` plus the now-unused
      `src/lib/sms/{messages,twilio}.ts` and `src/lib/reviews/*` server halves
- [ ] Rollback if needed: paste the Vercel URL back in Twilio (works until the route is deleted)

## At the REAL Xano cutover

- [ ] Disable the Xano bookings trigger "City tour campaign_v1" (trigger id 30, table 64).
      Supabase already sends for Supabase-native bookings; Xano still sends for its own,
      so there is no overlap today, but this is the switch that ends Xano's half.
- [ ] Set the `XANO_SMS_FORWARD_URL` function secret to `""` to stop mirroring inbound
      webhooks to Xano
- [ ] Turn on the review funnel (`messaging_settings.review_automation_enabled`) only
      after the mirror is off, or customers get texted twice. Set the `APP_URL` secret
      first: it is the base of the `/r/<token>` review link.
- [ ] Optional: notifications when a customer texts in (Xano pings the merchant today;
      here it is only visible in `/messages`)
- [ ] Cleanup: regenerate `src/lib/supabase/database.types.ts` (sms tables are untyped
      casts today), and remove the Xano SMS endpoints/functions once everything is off

## Xano reference (read-only, do not modify)

- Send chain: trigger 30 -> fn 93 "send sms telnyxs" -> fn 225 "communication/send sms v2" (Twilio)
- Inbound: api 788 `receive/sms_respose_twilio` (group "brevo") -> fn 95 logs -> fn 269 analyzes
- Sender number: +18774608995; workspace PWC id 6, branch v1
