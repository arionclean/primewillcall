# WhatsApp

WhatsApp runs on the same Twilio account and the same messaging engine as SMS, but it
is not a second SMS channel. Meta's rules change what you are allowed to send, and
almost everything here exists to respect them.

## The two rules that shape the design

1. **A business may only open a conversation with an approved template.** Templates are
   created in Twilio's Content API and approved by Meta. Free text sent cold is rejected
   (Twilio error 63016).
2. **A customer reply opens a 24-hour service window.** Inside it, free-form messages are
   allowed, no template needed. Every new reply restarts the 24 hours. When it closes,
   you are back to templates only.

So "can we send this?" is never a property of the message. It is a property of the
conversation, and it can only be answered by knowing when the customer last wrote to us.

## How that is modelled

| Piece | Where | What it does |
| --- | --- | --- |
| `whatsapp_messages.direction` | migration `whatsapp_inbound` | `inbound` / `outbound`, matching `sms_messages`. The table was outbound-only, so nothing recorded a reply and the window could not exist. |
| `whatsapp_window_open(phone)` | Postgres function | True when an inbound row for that number is under 24h old. The single source of truth, so the app and the database never disagree. |
| `_shared/whatsapp.ts` | edge functions | `sendWhatsapp()` reads the window and picks free-form or template itself. Callers pass both a body and a template sid and get whichever is legal. |
| `twilio-inbound-sms` | edge function | Twilio posts WhatsApp to the same webhook, addressed `whatsapp:+1...`. WhatsApp is logged to `whatsapp_messages` (that row is what opens the window); SMS keeps its existing path. |
| `whatsapp-send` | edge function | Staff-facing send. JWT on, staff resolved from the caller's token. Returns `windowOpen` and which `mode` was actually used. |
| `whatsapp-templates` | edge function | The template catalog: list with approval status, and submit new ones. Twilio, not our DB, is the source of truth for approval. |

Two constraints on `whatsapp_messages` had to go, because both rejected the rows the
feature depends on:

- `business_id` was `NOT NULL`. An inbound message arrives from whoever wants to write
  to us, and the number may match no customer, so there may be no business to name.
- `status` was `CHECK (status IN ('sent','failed'))`, which no real message satisfies:
  Twilio returns `queued` or `accepted` on send, and inbound is `received`.

## Deliberate choices

- **Inbound WhatsApp does not reach the review funnel.** The funnel asks over SMS and
  decides from the last SMS we sent, so a WhatsApp message is never an answer to it.
- **Inbound WhatsApp is not mirrored to Xano.** Xano only ever handled SMS; a WhatsApp
  payload is a message it cannot place.
- **Opt-out is per person, not per channel.** STOP on WhatsApp stops the texts too.
- **The window check fails closed.** If the lookup errors, we send a template rather than
  risk a rejected free-form message.

## Sender configuration

The sender `whatsapp:+17868226594` ("Booking Notifications", ONLINE) posts incoming
messages to `https://qbnizuhozzwkiitfkjee.supabase.co/functions/v1/twilio-inbound-sms`
(POST). It was set through the Messaging v2 Senders API, not the console: the console's
sender form refuses to save until the public "Profile about" is filled in, and its save
call was returning 404 regardless. The API updates the webhook alone and leaves the
public profile untouched, which is what we want.

## Not live yet

The plumbing is deployed, tested and receiving. What is missing is surface:

1. **No automation uses WhatsApp.** Every `messaging_rules` row is `channel = 'sms'`.
   One approved template exists (`key_west_confirmation`).
2. **The staff Messages screen is SMS-only.** It reads `sms_messages` and calls
   `sms-send`. Sending WhatsApp by hand means merging the two tables into one thread
   view, which is a UI change, not a plumbing one.

## Testing it

The window is provable without sending anything:

```sql
select whatsapp_window_open('+1XXXXXXXXXX');
```

Insert an `inbound` row for that number, and it flips to true for 24 hours. A signed
POST to `twilio-inbound-sms` with `From=whatsapp:+1...` does the same thing through the
real path.
