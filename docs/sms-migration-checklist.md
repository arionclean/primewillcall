# SMS migration checklist (Twilio: Xano -> Supabase)

Status and remaining work for moving SMS off Xano. Background and architecture:
[sms-twilio.md](sms-twilio.md).

## Already done

- [x] `sms_messages` / `sms_opt_outs` tables, RLS, realtime, `sms_conversations()` RPC (applied to Supabase)
- [x] Outbound send lib + `POST /api/sms/send` (staff auth, opt-out aware, logs + links customers)
- [x] Inbound webhook `POST /api/webhooks/twilio/sms` (signature check, logging, STOP/START, mirrors payload to Xano)
- [x] History sync from the Twilio Messages API (`POST /api/sms/sync`, dedupe by `twilio_sid`)
- [x] Chat UI at `/messages` with realtime updates
- [x] Messaging rules engine `runNewBookingRules()` in src/lib/sms/rules.ts (owner-editable rules in /admin/messaging replace the Xano trigger "City tour campaign_v1")

## Safe to do NOW (Xano keeps working, zero risk)

These can be done any time before the real migration; the webhook mirroring
(`XANO_SMS_FORWARD_URL`) keeps Xano's flow fully alive.

- [ ] Push the branch and deploy to Vercel
- [ ] Set Vercel env vars: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`,
      `SUPABASE_SERVICE_ROLE_KEY`, both `NEXT_PUBLIC_SUPABASE_*`,
      `TWILIO_WEBHOOK_BASE_URL` = production URL, and leave `TWILIO_VALIDATE_SIGNATURE` unset (on)
- [ ] In Twilio (number 877-460-8995, Messaging, "A message comes in"):
      save the current Xano URL somewhere (rollback), then set
      `https://<production-domain>/api/webhooks/twilio/sms` (HTTP POST)
- [ ] Test: text the number, message appears in /messages AND Xano still reacts
      (its notification still arrives); reply from the chat
- [ ] Rollback if needed: paste the old Xano URL back in Twilio

## At the REAL migration (needs Xano switched off)

- [ ] Wire `runNewBookingRules()` into the Supabase booking-creation flow
      (xano-booking-sync edge function or wherever bookings are inserted), so the
      new-booking SMS comes from here instead of Xano's bookings trigger
- [ ] Disable the Xano bookings trigger "City tour campaign_v1" (trigger id 30, table 64)
      the moment the step above is live, so customers do not get double texts
- [ ] Set `XANO_SMS_FORWARD_URL=""` in Vercel to stop mirroring webhooks to Xano
- [ ] Decide on the review funnel: Xano's "analyze inbound message_v2" (rate 1-5 ask,
      AI classification, Google-review ask via Make, flowList timers) stops working
      when mirroring stops. Rebuild in Supabase or retire it.
- [ ] Optional: notifications when a customer texts in (Xano pings the merchant today;
      here it is only visible in /messages)
- [ ] Cleanup: regenerate `src/lib/supabase/database.types.ts` (sms tables are untyped
      casts today), and remove the Xano SMS endpoints/functions once everything is off

## Xano reference (read-only, do not modify)

- Send chain: trigger 30 -> fn 93 "send sms telnyxs" -> fn 225 "communication/send sms v2" (Twilio)
- Inbound: api 788 `receive/sms_respose_twilio` (group "brevo") -> fn 95 logs -> fn 269 analyzes
- Sender number: +18774608995; workspace PWC id 6, branch v1
