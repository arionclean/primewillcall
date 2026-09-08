-- The owner asked not to see the copy-to-Xano status on the dashboard, so the queue
-- is read by SQL only. The table comment said otherwise.
comment on table public.xano_mirror_queue is
  'Outbox of booking changes waiting to be copied into Xano. Written by the enqueue_xano_mirror trigger, drained every minute by the xano-mirror-dispatch edge function. failed = gave up (the error says why). Read it by SQL; nothing in the app shows it.';
