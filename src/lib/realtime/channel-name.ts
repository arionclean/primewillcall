/**
 * A Realtime channel topic that is unique to one subscription.
 *
 * supabase-js hands back the EXISTING channel when a topic is reused
 * (`client.channel("x")` twice is one channel), and `removeChannel()` only
 * tears a channel down after its unsubscribe round trip. So an effect that
 * closes a channel and opens the "same" one in the next render (a date change
 * on the bookings screen, or the sidebar Manifest mounted in both the desktop
 * sidebar and the phone drawer) was calling `.on()` on a channel that had
 * already subscribed, which throws "cannot add postgres_changes callbacks after
 * subscribe()" (Sentry, 2026-09-08). Every subscription now gets its own
 * topic: the base name for the log, a counter for uniqueness.
 */
let counter = 0;

export function liveChannelName(base: string): string {
  counter += 1;
  return `${base}:${counter}`;
}
