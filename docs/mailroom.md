# The Mailroom (inbound OTA booking emails)

How an OTA reservation email becomes a booking, what each step did with it, who gets
told when it goes wrong, and what to do when the alarm goes off.

The Mailroom replaced the Make scenario **"Mailhook-sky trigger"** (team LA BOLA,
scenario 2362355), which received the email on a Make mailhook address and made the
HTTP calls. Make was switched off on **2026-09-23 at 11:50 UTC**. The logic was never
the hard part. The part worth keeping was Make's execution history: somewhere to see
that an email arrived, what each step did with it, and what became of it. That is
what `inbound_emails` and the Mailroom screen are for.

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
                                              3. fetch: GET /emails/receiving/{id}  (the body)
                                              4. read:  email-booking-parse   (regex + AI product match)
                                              5. book:  xano-booking-sync     (upsert the booking)
     ->  the bookings trigger texts the guest (a booking this email created)
```

Resend's `email.received` webhook carries **metadata only**. The body is a second
call, `GET https://api.resend.com/emails/receiving/{id}`, which is also why retrying
is free: Resend keeps the email whether or not our webhook ever succeeded.

The pass lives in `supabase/functions/_shared/inbound-email.ts` (`runPass`), used by
both the webhook and the sweep, so they cannot drift apart.

## The guest's texts

Every OTA booking the Mailroom creates is keyed `ota-<reference>` in `legacy_id` (that
key is what makes a resent or amended email land on the one booking), and every
ownership rule in the messaging engine used to read "ours" as `legacy_id IS NULL`. While
Make ran, that was right: Make also posted each email into Xano, and Xano texted the
guest. With Make off, Xano never hears of these bookings.

So the Mailroom marks the booking it **creates** with the email it came from,
`bookings.inbound_email_id` (set by the sync on insert only), and that mark makes it
ours:

- `trg_native_booking_automations` fires for it (the confirmation texts, through
  `run-booking-automations`), when it is inserted `confirmed` and the departure is
  still ahead. A cancellation email for a booking we never had, or an email that
  arrives after the tour, texts nobody.
- `enqueue-review-asks` takes it (the review funnel after the tour).

An email that **updates** a booking created earlier never sets the mark, so a booking
Xano already texted (everything from before the switch) is never texted twice.

**Foreign numbers keep their `+`** (`storablePhone`, since 2026-09-23). Until then the
reader kept digits only, and a ten-digit foreign number ("+47 912 34 567", Norway;
Denmark and Singapore are the same length) became ten bare digits, which read as a
US number: the guest's confirmation would have gone to whoever holds that US number.
None had arrived yet. With the plus, a foreign number takes the non-US trigger, whose
WhatsApp rules are switched off, so a foreign guest gets no text, as under Xano (its
trigger texted US numbers only). US numbers store exactly as before: in the first 89
emails every one came as "+1", "US+1" or with no plus at all.

## The log: `inbound_emails`

One row per email, written **before** any parsing. Unique on
`(provider, provider_email_id)`, so Resend's retries, our sweep and a manual retry
all converge on one row and one booking.

| status | meaning | screen |
| --- | --- | --- |
| `received` | recorded, not finished. The sweep will try again. | Working on it |
| `parsed` | read fine, but not a reservation (a bounce, a newsletter). Nothing to book, and deliberately not a failure. | Not a booking |
| `booked` | a booking exists. `booking_id` points at it. | Booked |
| `failed` | a person owns it: out of attempts, or it looks like a booking but reads as nothing. Alerted once. Only Retry sends it round again. | Needs a look |
| `ignored` | set aside by hand (`ignored_at`, `ignored_by`). | Set aside |

- `steps` is what the latest pass did, in order: `fetch`, `read`, `book`, each with
  `ok`, when it started, how long it took, a one-line `note`, and `data` (what the read
  extracted: reference, departure, guest, phone, guests, channel, product, the matched
  tour; what the sync answered: created or updated). It is kept when a pass fails,
  which is when it matters. This is Make's per-module input and output, kept for good.
- `warnings` holds codes for details the read could not find on a booking it still
  made: `no_guest_count` and `guest_count_mismatch` (both alerted once),
  `no_guest_name` (the booking lands as "Guest") and `no_channel` (screen only). Make
  refused to book those and pushed an alert; the Mailroom books what it can, because
  a guest on the manifest with a gap beats no guest. A missing name stays screen-only:
  the 6 of the first 65 bookings that landed as "Guest" turned out to be a reader bug
  (see "What the first real email taught us", point 3), not emails without a name.
- `raw_text` keeps what the reader actually saw, so a wrong booking can be explained
  later without asking Resend for an email it may no longer hold. It is kept even
  when a later step fails.

Owner reads it, nobody writes it directly: every write comes from an edge function on
the service role, or from the two owner functions below, which change only the
processing state and never the email itself.

## The alarms

**1. A row that fails.** `email-inbound-sweep` (pg_cron, every 5 minutes) retries
anything still `received`, claimed through `mailroom_claim_pending` (`FOR UPDATE SKIP
LOCKED`, so two runs never work one email). Both the read and the booking upsert are
safe to repeat. After `inbound_email_settings.max_attempts` (5) the row goes `failed`.
An email that looks like a booking (a booking label in the text, or "booking",
"reservation", "cancelled" in the subject) but reads as no reference and no date goes
`failed` on the spot: another try cannot help, and the first real email through here
failed exactly like that.

**2. Telling a person, once.** The same sweep calls `mailroom_claim_alerts`, which
stamps `alert_sent_at` on every row a person has not been told about (failed, or
booked with a wrong head count) in the same statement it returns them, then sends one
email and one text for the batch, each with a link to the email on the Mailroom
screen. If nothing could be sent the claim is released for the next run.

**3. The intake going quiet.** No row-level check can report the email that never
arrived: a deleted forwarding rule, an MX record edited during unrelated DNS work, a
suspended domain. The sweep compares the newest `received_at` against
`inbound_email_settings.silence_minutes` (180) and alerts. It only ever fires once at
least one email has arrived, and it sleeps between `quiet_from_hour` and
`quiet_to_hour` (22:00 to 08:00 New York) because an alarm that cries at 4am gets
muted, and a muted alarm is no alarm. One alert per window (`last_silence_alert_at`).

**4. The sweep itself stopping.** Every alarm above lives in the sweep, so a sweep that
stops running (its cron entry gone, pg_net stuck, a rotated secret answering 401, the
project down) takes them all with it. Each scheduled run checks in with a **Sentry cron
monitor**, slug `mailroom-sweep`, schedule `*/5 * * * *`, created by the first
check-in (`withCronMonitor` in `_shared/sentry.ts`). Two missed or failed check-ins in
a row open an issue in Sentry, which is the one watcher that does not depend on the
thing it watches. A run refused for a bad secret never checks in, on purpose. Make
sure Sentry notifies you for new issues, or this alarm has nobody to ring.

Alerts go to `messaging_settings.alert_email` and `alert_phone` (the owner's number,
set 2026-09-23), the same pair the messaging cap alert uses.
`inbound_email_settings.alerts_enabled` is the master switch, and the screen says so
when it is off.

## The screen: `/admin/mailroom`

An internal tool: **owner only, and linked from nowhere in the app** (no sidebar entry,
no search, no dashboard card). The way in is the link in an alert, which opens that
email (`?email=<id>`), or typing the address.

It leads with the health line (how long since the last email, how many need a look,
how many were booked today and how many came with a detail missing this week, all
counted over the whole log by `mailroom_summary()`), then the latest 50 emails, with a
"Needs a look" filter. Opening an email shows its journey as five stops (arrived,
fetched, read, booked, texted), each with its outcome and timing; what the read
extracted; the buttons; and, on request, the email as the reader saw it. It updates
over Realtime, so an email that lands, or a retry's result, appears without a reload.

- **Retry** (`mailroom_retry`): back to `received` with a fresh set of attempts, and a
  sweep run kicked at once, so the result shows in seconds. For failed, not-a-booking
  and set-aside emails.
- **Set aside** (`mailroom_set_aside`): junk that looked like a booking, or a failure
  already booked by hand.

Both check the owner inside the database.

## Setup

**Done on 2026-09-22.** The live setup is below; the steps are kept because they are
what a second business, or a rebuild, would repeat.

1. **Domain.** Receiving is enabled on the existing verified sending domain
   `updates.primewillcall.com`, giving the inbound address
   **`reservations@updates.primewillcall.com`**. A subdomain, never the apex: the real
   mailboxes live on `primewillcall.com` (MX -> Titan) and are not touched. Resend is
   connected to Cloudflare, so its **Auto configure** writes the MX record
   (`updates` -> `inbound-smtp.us-east-1.amazonaws.com`, priority 10). That button
   opens a Cloudflare popup and needs a human click.
2. **Webhook.** Point a Resend webhook at
   `https://qbnizuhozzwkiitfkjee.supabase.co/functions/v1/email-inbound`, event
   `email.received`. Copy the signing secret.
3. **Secrets** (Supabase function secrets): `RESEND_WEBHOOK_SECRET` (the `whsec_...`
   from step 2) and `RESEND_INBOUND_API_KEY`, plus the ones that already exist:
   `RESEND_API_KEY`, `EMAIL_PARSE_SECRET`, `XANO_WEBHOOK_SECRET`, `CRON_SECRET`,
   `APP_URL` (the alert links), `SENTRY_DSN` (the heartbeat).

   `RESEND_INBOUND_API_KEY` is a **second** Resend key, and it is separate on purpose.
   `GET /emails/receiving/{id}` needs a full-access key, while the key every sending
   path in the app carries is "Sending access". Upgrading that shared key would let
   any sender read all inbound mail and manage the Resend account, so the full-access
   key exists only for this one call. The fetch reads it first and falls back to
   `RESEND_API_KEY`.
4. **Deploy**: `email-inbound`, `email-inbound-sweep`. Both are `verify_jwt = false`
   in `config.toml` (Resend cannot send a Supabase token; the signature is the guard,
   and the sweep uses `x-cron-secret`).
5. **Test with a real forwarded OTA email**, never a synthetic one, and watch the
   Mailroom. See "What the first real email taught us" below.
6. **Cut over** (done 2026-09-23). The Mailroom and Make ran side by side from
   2026-09-22 14:21 UTC: the upsert is keyed on the OTA reference, so both paths
   landed on the same booking and nothing doubled. Make went off at 11:50 UTC the next
   day, and the guest texts moved here in the same hour (see "The guest's texts").

## Which business an email belongs to

Ported from the Make scenario: if either of the first two addresses of the original
`To:` header contains `reservations@keywestsightseeingtours.com` it is Key West,
otherwise Miami (Bubble company ids, matched against `businesses.legacy_company_id`).
A third business is a third line in `KEY_WEST_INBOX` / `COMPANY_*` in
`_shared/inbound-email.ts`.

The mail arrives forwarded, so the envelope recipient is our own inbound address and
the address that decides the business is somewhere else. `originalRecipients()` reads
the original `To:` header in whatever shape Resend returns it (a map, a list of
pairs, or the raw block), and `companyFor()` applies the positional rule. The
addresses used are recorded on the row (`to_addresses`) and in the fetch step, so the
decision can be checked instead of taken on trust.

Get this wrong and every email looks like Miami, which is not a crash and not an
empty screen: it is a Key West guest sitting in the Miami manifest.

## What the first real email taught us

The first real forwarded email (2026-09-22, a GetYourGuide booking on Key West) did
not go through, and both reasons are worth keeping:

1. **The body fetch 401'd**: the account's Resend key was "Sending access" only. Hence
   `RESEND_INBOUND_API_KEY`, above.
2. **The parser read nothing.** Gmail rebuilt the plain part from Bokun's HTML and
   wrote every bold label as `*Booking ref.*`. The label patterns expect the value
   right after the label, so the asterisk broke all of them, and an email with no
   fields was indistinguishable from a newsletter: it landed as `parsed`, the status
   that means "not a reservation". A real booking quietly filed as junk is the exact
   failure this pipeline exists to prevent. `parseBookingEmail` now strips emphasis
   that wraps a label at the start of a line (a case in
   `_shared/parse-booking-email.test.ts`), and an empty read of an email that looks
   like a booking now goes `failed` and alerts (`looksLikeBooking`, tested in
   `_shared/inbound-email.test.ts` against the first 66 real emails: all 65 bookings
   look like one, the Gmail forwarding confirmation does not).
3. **A line wrap inside a label.** Plain-text email wraps long lines, and in 9 of the
   first 65 emails the wrap landed inside "Customer email" (`Customer\nemail`). Every
   label pattern spelled its words with one space, so those emails lost the guest's
   name and email together, and 6 bookings went on the manifest as "Guest". The name
   was in every one of them. Fixed 2026-09-23: `parseBookingEmail` collapses all
   whitespace before reading (nothing in it reads line breaks), which read all 65 names
   and emails with no other field changing; a case in
   `_shared/parse-booking-email.test.ts`. The 6 guests were renamed from their stored
   emails the same day.

## When the alarm goes off

**"No OTA booking emails have arrived"**, in order:

1. The forwarding rule on the reservations mailbox (someone turns these off).
2. The MX record on the inbound subdomain.
3. The Resend webhook: still pointed at `email-inbound`, and is it failing? Resend
   keeps the emails either way, so nothing is lost yet.

Once fixed, the sweep picks up anything already recorded. Emails that never reached
Resend at all have to be re-forwarded from the mailbox.

**"A booking email could not be processed"**: open the link, read which step broke
and the email itself. A layout the reader has never seen is the likely cause, and is
worth a case in `_shared/parse-booking-email.test.ts`. Then Retry it after a fix, or
book the guest by hand from `/schedule` and Set it aside.

**"A booking came in with missing details"**: the booking exists; open it and fix the
head count by hand.

**A Sentry issue for `mailroom-sweep`**: the sweep is not running. Check the pg_cron
job `email-inbound-sweep` (`select * from cron.job where jobname =
'email-inbound-sweep'`), the latest responses in `net._http_response`, and the
function's logs. Until it runs again nothing is retried and no alarm can fire.
