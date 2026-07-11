# Messaging automations (with waits)

Owner-built rules that text customers automatically when a booking comes in. Edited at
`/admin/messaging` (Automations tab). This doc covers the data model, the "wait" delivery
path, and the checklist to make it actually send in production.

## The model

An **automation** is a **trigger** plus one or more **actions**:

- **Trigger**: `messaging_rules.trigger_event` (only `new_booking` today) + `business_tour_id`
  (the product, `null` = any product). Rows that share a trigger render as one automation.
- **Action**: a single `messaging_rules` row (a message). Each has a `channel`
  (`sms` / `whatsapp`), the body or WhatsApp template, `only_first_contact`, `is_active`,
  and now `delay_minutes`.

**Wait** = `delay_minutes > 0` on an action: send it that many minutes after the booking
(0 = immediately). The builder shows it as a "Wait 2 hours" node before the message. Max
30 days (`43200`).

## How a wait actually fires

1. A booking is created and calls `maybeRunNewBookingRules(ctx)`
   (`src/lib/sms/rules.ts`). Gated by `MESSAGING_AUTOMATIONS_ENABLED` and never throws.
2. `runNewBookingRules` loads the matching active rules. For each:
   - `delay_minutes === 0` -> send **inline** via Twilio (unchanged behaviour).
   - `delay_minutes > 0` -> render now and **enqueue** a row in `public.scheduled_messages`
     with `send_at = now + delay` (a later edit to the rule does not rewrite what is queued).
3. `pg_cron` calls the **`dispatch-scheduled-messages`** edge function every minute. It
   `claim_due_scheduled_messages()` (atomic `FOR UPDATE SKIP LOCKED`, so concurrent runs
   never double-send), sends each due row through Twilio, and marks it `sent` / `failed`.

Tables/functions live in `supabase/migrations/20260711120000_scheduled_messages.sql`.

## Go-live checklist

The schema migration is already applied. To turn sending on:

1. **Twilio env on the Next app** (Vercel): `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
   `TWILIO_FROM_NUMBER`, `TWILIO_WHATSAPP_FROM`, and `BOOKING_LINK_BASE_URL`
   (defaults to `https://bked.io/booking`).
2. **Deploy the dispatcher** (no JWT gate; it authenticates with a shared secret):
   `supabase functions deploy dispatch-scheduled-messages --no-verify-jwt`
   Set its secrets: `supabase secrets set TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=...
   TWILIO_FROM_NUMBER=... TWILIO_WHATSAPP_FROM=... CRON_SECRET=<random-long-string>`
3. **Schedule the cron** (SQL below), storing the same `CRON_SECRET` in Vault.
4. **Wire the other booking path**: add the same `maybeRunNewBookingRules({...})` call after
   the booking insert in `src/app/api/gp/book/route.ts` (the internal `/schedule` flow is
   already wired in `src/app/(app)/schedule/actions.ts`).
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
