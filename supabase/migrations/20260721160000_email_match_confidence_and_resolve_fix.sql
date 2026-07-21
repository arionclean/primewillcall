-- OTA match queue: numeric AI confidence + two fixes to resolving.
--
-- 1) ai_confidence_score: the classifier now returns a real 0..1 number instead
--    of only the string 'high'/'low'. The old text column stays for the rows
--    that predate this (they have no score and are shown as legacy in the UI).
--
-- 2) resolve_email_match had two problems:
--    a) The matcher optimistically writes an alias (source 'ai') the moment it
--       makes a high-confidence guess. Resolving then inserted the alias with
--       ON CONFLICT DO NOTHING, so resolving to a DIFFERENT tour left the wrong
--       AI alias in place and every future email kept matching wrong. A human
--       resolve is authoritative, so it now overwrites.
--    b) High-confidence matches are already live as bookings (the email
--       connector creates them from the returned product_match). Resolving to a
--       different tour left that booking pointing at the wrong product. It now
--       re-points the existing booking too, scoped to the same business and
--       keyed on the parsed bookingReference. No-op for urgent rows (no booking).

ALTER TABLE public.email_match_queue
  ADD COLUMN IF NOT EXISTS ai_confidence_score numeric(4, 3);

ALTER TABLE public.email_match_queue
  DROP CONSTRAINT IF EXISTS email_match_queue_ai_confidence_score_check;
ALTER TABLE public.email_match_queue
  ADD CONSTRAINT email_match_queue_ai_confidence_score_check
  CHECK (
    ai_confidence_score IS NULL
    OR (ai_confidence_score >= 0 AND ai_confidence_score <= 1)
  );

CREATE OR REPLACE FUNCTION public.resolve_email_match(p_queue_id uuid, p_tour_id uuid)
RETURNS email_match_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  q public.email_match_queue;
  cs record;
  v_bt_id uuid;
  v_src_bt uuid;
  v_ref text;
begin
  select * into q from public.email_match_queue where id = p_queue_id;
  if not found then raise exception 'queue row not found'; end if;

  select staff_id, role, business_id into cs from public.current_staff() limit 1;
  if cs.staff_id is null then raise exception 'not authenticated'; end if;
  if cs.role is distinct from 'owner'::public.staff_role
     and not (cs.business_id is not null and cs.business_id = q.business_id) then
    raise exception 'not permitted for this business';
  end if;

  -- 1) learn: future emails with this product name resolve deterministically.
  --    A human decision OVERWRITES any earlier guess (the matcher may have
  --    already written an 'ai' alias pointing at the wrong tour).
  if q.original_product_name is not null and btrim(q.original_product_name) <> '' then
    insert into public.tour_name_aliases (tour_id, normalized_name, raw_name, source)
    values (p_tour_id, public.app_norm(q.original_product_name), q.original_product_name, 'manual')
    on conflict (normalized_name) do update
      set tour_id = excluded.tour_id,
          raw_name = excluded.raw_name,
          source = 'manual';
  end if;

  -- 2) assign: make sure the operator has a business_tour for this tour.
  if q.business_id is not null then
    select id into v_bt_id from public.business_tours
      where business_id = q.business_id and tour_id = p_tour_id limit 1;
    if v_bt_id is null then
      insert into public.business_tours (business_id, tour_id, name, is_active)
      select q.business_id, p_tour_id, t.name, true
      from public.tours t where t.id = p_tour_id
      returning id into v_bt_id;
      -- clone the price tiers from an existing copy of this tour, if any.
      select bt.id into v_src_bt from public.business_tours bt
        where bt.tour_id = p_tour_id and bt.id <> v_bt_id
        order by bt.created_at limit 1;
      if v_src_bt is not null then
        insert into public.tour_pax_tiers
          (business_tour_id, label, description, price_cents, currency, sort_order, is_active)
        select v_bt_id, t.label, t.description, t.price_cents, t.currency, t.sort_order, t.is_active
        from public.tour_pax_tiers t where t.business_tour_id = v_src_bt;
      end if;
    end if;
  end if;

  -- 3) correct the live booking. A high-confidence match is already booked with
  --    the AI's product, so resolving to a different tour must move it too.
  v_ref := nullif(btrim(coalesce(q.parsed ->> 'bookingReference', '')), '');
  if v_bt_id is not null and v_ref is not null then
    update public.bookings b
      set business_tour_id = v_bt_id
    where b.legacy_reference = v_ref
      and b.business_tour_id is distinct from v_bt_id
      and (q.business_id is null or b.business_id = q.business_id);
  end if;

  update public.email_match_queue
    set status = 'resolved', resolved_tour_id = p_tour_id,
        resolved_by_staff_id = cs.staff_id, resolved_at = now()
    where id = p_queue_id
    returning * into q;
  return q;
end;
$function$;
