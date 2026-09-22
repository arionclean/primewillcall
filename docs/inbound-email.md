# Inbound OTA booking emails (Resend)

How an OTA reservation email becomes a booking, who notices when it does not, and
what to do when the alarm goes off.

This replaces the Make scenario **"Mailhook-sky trigger"** (team LA BOLA, scenario
2362355), which received the email on a Make mailhook address and made two HTTP
calls. The logic was never the hard part. The part worth keeping was Make's
execution history: somewhere to see that an email arrived and what became of it.
That is what `inbound_emails` and `/admin/inbound` are for.

## Why this pipeline gets more safety net than the others

An OTA email is a real person's reservation. If one is dropped, nothing in the app
looks wrong: the bookings list is simply missing a guest nobody knows about, and the
failure surfaces when they arrive at the dock for a departure that has no seat for
them. Every other integration here fails loudly. This one fails invisibly, so it is
built around noticing rather than around sending.

## The chain

```
OTA  ->  reservations@<business mailbox>
     ->  forwarded to the Resend inbound address
     ->  Resend  --email.received webhook-->  email-inbound
                                              1. verify the signature
                                              2. INSERT inbound_emails  <- before anything else
                                              3. GET /emails/receiving/{id}  (the body)
                                              4. email-booking-parse         (regex + AI product match)
                                              5. xano-booking-sync           (upsert the booking)
```

Resend's `email.received` webhook carries **metadata only**. The body is a second
call, `GET https://api.resend.com/emails/receiving/{id}`, which is also why retrying
is free: Resend keeps the email whether or not our webhook ever succeeded.

The shared steps live in `supabase/functions/_shared/inbound-email.ts`
(`processInbound`), so the webhook and the cron cannot drift apart.

## The log: `inbound_emails`

One row per email, written **before** any parsing. Unique on
`(provider, provider_email_id)`, so Resend's retries, our sweep and a manual replay
all converge on one row and one booking.

| status | meaning |
| --- | --- |
| `received` | recorded, not finished. The sweep will try again. |
| `parsed` | read fine, but not a reservation (a bounce, a newsletter). Nothing to book, and deliberately not a failure. |
| `booked` | a booking exists. `booking_id` points at it. |
| `failed` | out of attempts. Someone has to look. Alerted once. |
| `ignored` | set aside by hand. |

`raw_text` keeps what the parser actually saw, so a wrong booking can be explained
later without asking Resend for an email it may no longer hold.

Owner reads it, nobody writes it: every write comes from an edge function on the
service role. There is no path for a staff member to alter the intake record, which
is the whole point of keeping one.

## The three alarms

**1. A row that fails.** `email-inbound-sweep` (pg_cron, every 5 minutes) re-runs
anything still `received` or `failed` with attempts left. Both the parse and the
booking upsert are safe to repeat. After `inbound_email_settings.max_attempts` (5)
the row goes `failed` and the owner gets one email plus one text.

**2. The intake going quiet.** No row-level check can report the email that never
arrived: a deleted forwarding rule, an MX record edited during unrelated DNS work, a
suspended domain. The sweep compares the newest `received_at` against
`inbound_email_settings.silence_minutes` (180) and alerts. It only ever fires once at
least one email has arrived, so it stays silent until the webhook is really pointed
here, and it sleeps between `quiet_from_hour` and `quiet_to_hour` (22:00 to 08:00 New
York) because an alarm that cries at 4am gets muted, and a muted alarm is no alarm.
One alert per window, tracked in `last_silence_alert_at`.

**3. The screen.** `/admin/inbound` (owner only) leads with how long ago the last
email arrived and how many failed, then lists the recent emails with what each
became. It updates over Realtime, so an email that lands while it is open appears on
it.

Alerts go to `messaging_settings.alert_email` and `alert_phone`, the same pair the
messaging cap alert uses. `inbound_email_settings.alerts_enabled` is the master
switch, and the screen says so when it is off.

## Setup

1. **Domain.** Add an inbound domain in Resend on a **subdomain**
   (`inbound.primewillcall.com`), not the apex, so normal mail is untouched. Add the
   MX record Resend gives you. Its priority must be the lowest on that host.
2. **Webhook.** Point a Resend webhook at
   `https://qbnizuhozzwkiitfkjee.supabase.co/functions/v1/email-inbound`, event
   `email.received`. Copy the signing secret.
3. **Secrets** (Supabase function secrets): `RESEND_WEBHOOK_SECRET` (the `whsec_...`
   from step 2), plus the ones that already exist: `RESEND_API_KEY`,
   `EMAIL_PARSE_SECRET`, `XANO_WEBHOOK_SECRET`, `CRON_SECRET`.
4. **Deploy**: `email-inbound`, `email-inbound-sweep`. Both are `verify_jwt = false`
   in `config.toml` (Resend cannot send a Supabase token; the signature is the guard,
   and the sweep uses `x-cron-secret`).
5. **Test before any DNS change.** Resend hands out a managed address on a
   `resend.app` subdomain that needs no DNS at all. Send a real forwarded OTA email
   to it and watch `/admin/inbound`.
6. **Cut over.** Point the reservations mailbox's forwarding rule at the new address.
   Leave the Make scenario running alongside for a week: the booking upsert is keyed
   on the OTA reference, so both paths land on the same booking and nothing doubles.
   Then turn Make off.

## Which business an email belongs to

Ported from the Make scenario: if any recipient contains
`reservations@keywestsightseeingtours.com` it is Key West, otherwise Miami (Bubble
company ids, matched against `businesses.legacy_company_id`). A third business is a
third line in `KEY_WEST_INBOX` / `COMPANY_*` in `_shared/inbound-email.ts`.

**The one thing to test with a real email, not a synthetic one:** the mail arrives
forwarded, so the envelope recipient is our inbound address and the address that
decides the business survives only in the headers. `recipientsOf()` reads `to`, `cc`,
`delivered-to`, `x-forwarded-to` and `x-original-to` for exactly this reason. Get it
wrong and every email looks like Miami.

## When the alarm goes off

**"No OTA booking emails have arrived"**, in order:

1. The forwarding rule on the reservations mailbox (someone turns these off).
2. The MX record on the inbound subdomain.
3. The Resend webhook: still pointed at `email-inbound`, and is it failing? Resend
   keeps the emails either way, so nothing is lost yet.

Once fixed, the sweep picks up anything already recorded. Emails that never reached
Resend at all have to be re-forwarded from the mailbox.

**"An OTA booking email could not be processed"**: open `/admin/inbound`, read the
error and the email, and book the guest by hand from `/schedule`. The most likely
cause is a layout the parser has never seen, which is also worth a case in
`_shared/parse-booking-email.test.ts`.
