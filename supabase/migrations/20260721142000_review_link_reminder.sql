-- Restore the "you said 5 but never opened the link" nudge.
--
-- This was in the first cut, was approved, then got dropped during the rework
-- that added the re-ask. Dropping it was a mistake: it targets guests who have
-- ALREADY said they would give 5 stars and then got distracted, which is the
-- highest-intent group in the funnel and the whole point of it (a rating we
-- collected is not a Google review).
--
-- It needs its own stamp. reask_sent_at cannot be reused: that tracks the
-- re-ask to people who never replied at all, and the two never apply to the
-- same guest at the same stage.
alter table public.reviews
  add column if not exists link_reminder_sent_at timestamptz;

comment on column public.reviews.link_reminder_sent_at is
  'When the "here is that review link again" nudge was queued. Only ever sent once, only to 5-star guests who never opened the link.';

-- The sweep's third pass: rated 5, link sent, never opened, never nudged.
create index if not exists reviews_link_unclicked_idx
  on public.reviews (link_sent_at)
  where link_sent_at is not null
    and link_clicked_at is null
    and link_reminder_sent_at is null
    and cancelled_at is null;

-- The cancel trigger lists the funnel's tags explicitly, so it has to learn
-- the new one or an un-checked-in booking would leave this nudge queued.
create or replace function public.cancel_review_funnel()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  reason text;
begin
  reason := case
    when NEW.status = 'cancelled' then 'booking_cancelled'
    else 'unchecked'
  end;

  update public.reviews
     set cancelled_at = timezone('utc', now()),
         cancel_reason = reason
   where booking_id = NEW.id
     and cancelled_at is null;

  update public.scheduled_messages
     set status = 'canceled'
   where booking_id = NEW.id
     and status = 'pending'
     and tag in (
       'review_ask', 'review_reask', 'review_link',
       'review_followup', 'review_link_reminder'
     );

  return NEW;
end;
$$;
