-- Remove the "you said 5 but never opened the link" nudge again.
--
-- Reverses 20260721142000. Both files are kept rather than edited away so the
-- applied history stays reproducible; the funnel is back to four steps:
--   ask -> (re-ask if no reply) -> 5 goes to Google / 1-4 goes private.
--
-- link_clicked_at and the /r/<token> hop STAY. Click tracking is still how we
-- measure the 5-star-to-Google conversion. It just no longer triggers a send.
alter table public.reviews
  drop column if exists link_reminder_sent_at;

drop index if exists public.reviews_link_unclicked_idx;

-- Put the cancel trigger's tag list back to the four live tags.
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
     and tag in ('review_ask', 'review_reask', 'review_link', 'review_followup');

  return NEW;
end;
$$;
