-- Fix to 20260908100000_xano_mirror.sql, applied to the project right after it:
-- `text[] || 'literal'` resolved the literal as an array ("malformed array literal:
-- pax") and made every mirrored booking edit fail. array_append is explicit. The
-- original file carries the same fix, so a fresh environment replays both harmlessly.

create or replace function public.enqueue_xano_mirror()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fields text[] := '{}';
  v_op     text;
begin
  -- 1. A write that came from Xano (the sync's echo, the ghost script) or from code
  --    that mirrors on its own (the kiosk sale flow, the worker) never goes back.
  if public.xano_mirror_origin() in ('xano', 'mirror') then
    return null;
  end if;

  -- 2. The switch.
  if not exists (select 1 from public.xano_mirror_settings where id and enabled) then
    return null;
  end if;

  if tg_op = 'INSERT' then
    -- Only a booking born here that no other mirror owns.
    if new.legacy_id is not null then return null; end if;          -- came through the sync
    if new.source_channel = 'groupon' then return null; end if;     -- gp-xano-mirror, after payment
    if new.awaiting_payment then return null; end if;                -- hidden from staff too
    v_op := 'create';
  else
    if new.starts_at is distinct from old.starts_at then
      v_fields := array_append(v_fields, 'starts_at');
    end if;
    if new.business_tour_id is distinct from old.business_tour_id then
      v_fields := array_append(v_fields, 'business_tour_id');
    end if;
    if new.status is distinct from old.status then
      v_fields := array_append(v_fields, 'status');
    end if;
    if new.pax_adult is distinct from old.pax_adult
       or new.pax_child is distinct from old.pax_child
       or new.pax_infant is distinct from old.pax_infant then
      v_fields := array_append(v_fields, 'pax');
    end if;
    if new.checked_in_at is distinct from old.checked_in_at then
      v_fields := array_append(v_fields, 'checked_in_at');
    end if;
    if new.notes is distinct from old.notes then
      v_fields := array_append(v_fields, 'notes');
    end if;
    if coalesce(array_length(v_fields, 1), 0) = 0 then return null; end if;

    -- Not in Xano yet: nothing to update. A queued create sends the current state.
    if new.xano_booking_id is null and new.xano_internal_id is null and new.legacy_id is null then
      return null;
    end if;
    if new.awaiting_payment then return null; end if;
    v_op := 'update';
  end if;

  insert into public.xano_mirror_queue as q (booking_id, op, fields)
  values (new.id, v_op, v_fields)
  on conflict (booking_id) where status = 'pending'
  do update set
    fields = public.text_array_union(q.fields, excluded.fields),
    op = case when q.op = 'create' then 'create' else excluded.op end,
    next_attempt_at = least(q.next_attempt_at, now()),
    updated_at = now();

  return null;
end;
$$;
