# Capacity alerts

Tell the people who run a tour when one departure is close to full.

Port of Xano's `city tour full notification` and `everglades tour full
notification` bookings triggers (workspace 6, triggers 116 and 118). Xano
hardcoded the product ids, the threshold, one phone and one email, and faked
its dedupe by writing rows into an unrelated `messages` table.

An alert holds **one or more products**. That is not decoration: Xano's city
tour alert sums two products against a single threshold because they share the
same bus. Counting them apart would never reach the number.

## How it works

1. A booking is inserted, or edited in a way that can add seats to a departure
   (a checkout that finally paid, more guests, an un-cancel, a move to another
   time). Two triggers on `bookings` cover exactly those cases and nothing else.
2. The trigger reads `messaging_settings.slot_alerts_enabled`. Off means it
   stops there and nothing leaves the database.
3. On, it posts the booking id to the `slot-capacity-alert` edge function with
   the shared cron secret.
4. The function finds the alert watching that product (at most one, by unique
   index) and sums the seats on that departure with `capacity_alert_seats`:
   adults plus children, across every product the alert holds and every
   business selling them, skipping cancelled and unpaid-checkout rows. Infants
   ride on a lap and take no seat, the same rule as the check-in manifest.
5. Below the threshold, it stops. At or above it, it claims the departure by
   inserting into `capacity_alert_log`, then texts and emails.

## Tables

| Table | What it holds |
| --- | --- |
| `capacity_alerts` | One alert: `name`, `threshold_pax`, `phones`, `emails`, `is_active`. |
| `capacity_alert_tours` | Which products it watches. A product belongs to at most one alert (unique index), otherwise a booking would text twice. |
| `capacity_alert_log` | One row per departure already alerted on, unique on `(alert_id, starts_at)`. |
| `messaging_settings.slot_alerts_enabled` | The single kill switch. Default false. |

## Why the claim comes before the send

The unique key on `capacity_alert_log` is the dedupe, and it is taken before
any message goes out. A retry, a redelivered call, or two bookings landing at
once finds the seat taken and stops. The trade is that a crash between the
claim and the send loses one alert. That is the right way round: a missed
alert is a nuisance, a duplicate 2am text is not.

## Screen

`/admin/messaging`, Automations tab, "Capacity alerts". One switch for all of
them, then a row per alert: its name, the products it watches, the seat count
and the recipients. "Add an alert" makes another, "Remove this alert" deletes
one with its history.

## What is live as of 2026-09-11

Both migrations are applied and the function is deployed. Two alerts are
configured, matching Xano exactly:

| Alert | Products | Alerts at | Goes to |
| --- | --- | --- | --- |
| Miami City Tour | Miami 5 in 1 City Tour + Miami City Tour combo | 26 guests | (786) 858 3458 and reservations@keywestsightseeingtours.com |
| Everglades Tour | Everglades Tour | 15 guests | the same two |

The numbers are 26 and 15 because Xano fires *above* 25 and *above* 14, while
this fires *at or above* the number. Same behaviour, stated the way people read
it.

`messaging_settings.slot_alerts_enabled` is still **false**. Flipping it is the
only step left, and it belongs in the same sitting as switching Xano off.

## No backfire when it is switched on

Three future departures were already over the line when this was set up
(Miami City Tour on Sep 13, Sep 28 and Dec 12). A row was seeded into
`capacity_alert_log` for each, so they count as already alerted and the next
booking on them stays quiet. Re-run that seed just before flipping the switch,
since more departures may have crossed by then:

```sql
insert into public.capacity_alert_log (alert_id, starts_at, seats, threshold_pax)
select a.id, b.starts_at, sum(b.pax_adult + b.pax_child)::int, a.threshold_pax
  from public.bookings b
  join public.business_tours bt on bt.id = b.business_tour_id
  join public.capacity_alert_tours cat on cat.tour_id = bt.tour_id
  join public.capacity_alerts a on a.id = cat.alert_id
 where b.starts_at > now()
   and b.status <> 'cancelled'
   and b.awaiting_payment = false
 group by a.id, a.threshold_pax, b.starts_at
having sum(b.pax_adult + b.pax_child) >= a.threshold_pax
on conflict (alert_id, starts_at) do nothing;
```

## Switching Xano off

Both are table triggers on `bookings` in workspace 6, branch v1. Disable both,
not one:

- Trigger 116, `city tour full notification`
- Trigger 118, `everglades tour full notification`

Nothing else in Xano sends these. Leave them on and every alert goes out twice.

Secrets are already in place: `CRON_SECRET` for the call, Twilio's for the
text, `RESEND_API_KEY` for the email. The sender address comes from
`messaging_settings.alert_email_from`.

## Known gaps

- The threshold is a fixed number of guests, by choice, not a percentage of
  capacity. An alert can span products with different capacities, so the
  message quotes the guest count alone.
- One alert per departure. It does not alert again when the departure later
  sells out completely.
- A product belongs to at most one alert. Watching the same product from two
  alerts would text twice, so the database refuses it and the screen greys it
  out.
