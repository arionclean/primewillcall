-- Void, not delete.
--
-- Nobody deletes a booking or a sale any more. A record that should not count is
-- VOIDED: it stays on file, stamped with who voided it, when and why, and stops
-- counting everywhere. That is the whole point: a delete leaves no trace, a void
-- leaves the row, the actor and the reason in front of the owner.
--
-- Bookings. A void sets the existing `cancelled` status AND the void stamp
-- (voided_at, voided_by_staff_id, void_reason, plus voided_from_status so an
-- owner can restore it). Building on `cancelled` is deliberate: every manifest,
-- report, message rule and the tablet already leave cancelled bookings out, so a
-- voided booking stops counting with no other query touched, and the screens
-- tell the two apart by the stamp ("Voided" versus "Cancelled").
--
-- Cash sales. Same stamp on cash_sales. Card sales are not voided: a captured
-- charge can only be refunded, which is already built and already logged.
--
-- The permission `can_delete_bookings` becomes `can_void_bookings` (same rows,
-- same values, so whoever could delete can now void). The DELETE policy on
-- bookings is dropped outright: not even the owner deletes from the app.
--
-- Writes go through two functions, `void_booking` and `restore_booking`, both
-- SECURITY INVOKER so RLS still scopes them, with the column guard trigger as the
-- backstop. The activity log needs nothing new: a void is an UPDATE that
-- log_staff_change already records with its diff.

-- ── bookings: the void stamp ─────────────────────────────────────────────────

alter table public.bookings
  add column if not exists voided_at          timestamptz,
  add column if not exists voided_by_staff_id uuid references public.staff(id) on delete set null,
  add column if not exists void_reason        text,
  add column if not exists voided_from_status public.booking_status;

comment on column public.bookings.voided_at is
  'Set when staff void the booking (a mistake, a duplicate, a test). The row stays; status is forced to cancelled while this is set. Written by void_booking().';
comment on column public.bookings.voided_by_staff_id is
  'The login that voided the booking.';
comment on column public.bookings.void_reason is
  'Why it was voided, in the voider''s words. Required by void_booking().';
comment on column public.bookings.voided_from_status is
  'The status the booking had before the void, so restore_booking() can put it back.';

-- ── cash_sales: the void stamp ───────────────────────────────────────────────

alter table public.cash_sales
  add column if not exists voided_at   timestamptz,
  add column if not exists voided_by   uuid references public.staff(id) on delete set null,
  add column if not exists void_reason text;

comment on column public.cash_sales.voided_at is
  'Set when staff void the sale (recorded by mistake, a duplicate). The row stays and stops counting toward cash totals. Written by the payments function.';
comment on column public.cash_sales.voided_by is
  'The login that voided the sale.';
comment on column public.cash_sales.void_reason is
  'Why it was voided, in the voider''s words.';

-- A refund means the sale was real, so a refunded sale is never voided, and a
-- voided sale is never refunded. The payments function checks; this makes sure.
alter table public.cash_sales
  drop constraint if exists cash_sales_void_xor_refund;
alter table public.cash_sales
  add constraint cash_sales_void_xor_refund
  check (voided_at is null or coalesce(amount_refunded_cents, 0) = 0);

-- ── The permission: can_delete_bookings becomes can_void_bookings ────────────

alter table public.staff
  rename column can_delete_bookings to can_void_bookings;

comment on column public.staff.can_void_bookings is
  'May void bookings from the Bookings page (the record stays, stamped with who and why). Nobody deletes. Owners always may; only owners restore.';

-- The access token carries the renamed column. Same body as before, one key
-- renamed. (The claim is read by staffFromClaims() in src/lib/auth.ts, which
-- treats a token without can_void_bookings as older than this migration.)
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path to 'pg_catalog', 'public'
as $$
declare
  s      public.staff%rowtype;
  claims jsonb;
begin
  select * into s
  from public.staff
  where user_id = (event->>'user_id')::uuid
  limit 1;

  claims := event->'claims';

  if s.id is null then
    claims := jsonb_set(claims, '{app_staff}', 'null'::jsonb);
  else
    claims := jsonb_set(claims, '{app_staff}', jsonb_build_object(
      'id',                   s.id,
      'full_name',            s.full_name,
      'role',                 s.role,
      'business_id',          s.business_id,
      'is_active',            s.is_active,
      'kiosk_slug',           s.kiosk_slug,
      'can_create_bookings',  s.can_create_bookings,
      'can_edit_bookings',    s.can_edit_bookings,
      'can_check_in',         s.can_check_in,
      'can_void_bookings',    s.can_void_bookings,
      'can_add_to_peek',      s.can_add_to_peek,
      'can_view_attachments', s.can_view_attachments,
      'can_redeem_groupon',   s.can_redeem_groupon,
      'can_view_details',     s.can_view_details,
      'can_use_caja',         s.can_use_caja,
      'pin_required',         s.pin_required
    ));
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- ── No more deletes ──────────────────────────────────────────────────────────
-- With no DELETE policy the table fails closed for every signed-in role, owner
-- included. Foreign-key cascades (removing a business) still run: referential
-- actions are not subject to RLS.

drop policy if exists bookings_delete on public.bookings;

-- ── bookings UPDATE: a void-only account passes RLS ──────────────────────────
-- Same policy as 20260906224301 with can_void_bookings added to the switches
-- that open the row. The column guard below decides what such an account may
-- actually change.

drop policy if exists bookings_update on public.bookings;
create policy bookings_update on public.bookings
  for update to authenticated
  using (
    exists (
      select 1
      from public.current_staff() cs
      join public.staff s on s.id = cs.staff_id
      where cs.role = 'owner'
         or ((s.can_edit_bookings or s.can_check_in
              or s.can_add_to_peek or s.can_redeem_groupon
              or s.can_void_bookings)
             and ((cs.role = 'business_manager'
                   and cs.business_id = bookings.business_id)
                  or (cs.role = 'check_in'
                      and exists (
                        select 1 from public.staff_tours st
                        join public.business_tours bt on bt.tour_id = st.tour_id
                        where st.staff_id = cs.staff_id
                          and bt.id = bookings.business_tour_id))))
    )
  )
  with check (
    exists (
      select 1
      from public.current_staff() cs
      join public.staff s on s.id = cs.staff_id
      where cs.role = 'owner'
         or ((s.can_edit_bookings or s.can_check_in
              or s.can_add_to_peek or s.can_redeem_groupon
              or s.can_void_bookings)
             and ((cs.role = 'business_manager'
                   and cs.business_id = bookings.business_id)
                  or (cs.role = 'check_in'
                      and exists (
                        select 1 from public.staff_tours st
                        join public.business_tours bt on bt.tour_id = st.tour_id
                        where st.staff_id = cs.staff_id
                          and bt.id = bookings.business_tour_id))))
    )
  );

-- ── Column guard: the void stamp needs its own permission ────────────────────
-- Service-role writers (webhooks, edge functions, the Xano sync) have no
-- current_staff() row and pass through untouched. Owners pass. Everyone else:
-- check-in, peek, redeem and void each need their switch, only an owner clears a
-- void, and without edit nothing but those stamps may change. A void is the one
-- stamp that also moves the status (to cancelled, never anywhere else).

create or replace function public.enforce_booking_update_capabilities()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role         public.staff_role;
  v_can_edit     boolean;
  v_can_check_in boolean;
  v_can_peek     boolean;
  v_can_redeem   boolean;
  v_can_void     boolean;
  v_void_touched boolean;
  v_voiding      boolean;
  -- The columns an account without edit may change, each behind its own switch.
  stamps         text[] := array['checked_in_at', 'checked_in_by_staff_id', 'peek',
                                 'groupon_redeemed_at', 'voided_at', 'voided_by_staff_id',
                                 'void_reason', 'voided_from_status', 'updated_at'];
begin
  select cs.role, s.can_edit_bookings, s.can_check_in, s.can_add_to_peek,
         s.can_redeem_groupon, s.can_void_bookings
    into v_role, v_can_edit, v_can_check_in, v_can_peek, v_can_redeem, v_can_void
    from public.current_staff() cs
    join public.staff s on s.id = cs.staff_id
   limit 1;

  if not found or v_role = 'owner' then
    return new;
  end if;

  if not v_can_check_in
     and (new.checked_in_at is distinct from old.checked_in_at
          or new.checked_in_by_staff_id is distinct from old.checked_in_by_staff_id) then
    raise exception 'Your account can''t check guests in.';
  end if;

  if not v_can_peek and new.peek is distinct from old.peek then
    raise exception 'Your account can''t change Peek status.';
  end if;

  if not v_can_redeem
     and new.groupon_redeemed_at is distinct from old.groupon_redeemed_at then
    raise exception 'Your account can''t redeem Groupon vouchers.';
  end if;

  v_void_touched := new.voided_at is distinct from old.voided_at
                 or new.voided_by_staff_id is distinct from old.voided_by_staff_id
                 or new.void_reason is distinct from old.void_reason
                 or new.voided_from_status is distinct from old.voided_from_status;
  if v_void_touched then
    if not v_can_void then
      raise exception 'Your account can''t void bookings.';
    end if;
    if old.voided_at is not null and new.voided_at is null then
      raise exception 'Only an owner can restore a voided booking.';
    end if;
  end if;

  if v_can_edit then
    return new;
  end if;

  -- Without edit: the stamps only. A void may flip the status to cancelled
  -- (that is what a void is) and nothing else.
  v_voiding := old.voided_at is null and new.voided_at is not null;
  if v_voiding and new.status <> 'cancelled' then
    raise exception 'A voided booking is cancelled.';
  end if;
  if v_voiding then
    stamps := stamps || 'status';
  end if;
  if (to_jsonb(new) - stamps) is distinct from (to_jsonb(old) - stamps) then
    raise exception 'Your account can only update check-in on bookings.';
  end if;
  return new;
end;
$$;

-- ── While voided, cancelled ──────────────────────────────────────────────────
-- Whatever writes to a voided booking (the edit form's status field, a status
-- resend from Xano through xano-booking-sync), the status stays cancelled until
-- the stamp is cleared. Runs after the guard (trigger names fire alphabetically).

create or replace function public.bookings_keep_voided_cancelled()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.status := 'cancelled';
  return new;
end;
$$;

drop trigger if exists bookings_keep_voided_cancelled on public.bookings;
create trigger bookings_keep_voided_cancelled
  before update on public.bookings
  for each row
  when (new.voided_at is not null)
  execute function public.bookings_keep_voided_cancelled();

-- ── A void cancels what was still to be sent ─────────────────────────────────
-- A confirmation waiting on a delay, a review ask: none of it should reach a
-- guest whose booking was a mistake. (The review funnel's own rows are already
-- cancelled by cancel_review_funnel, which fires on the status change.)
-- Definer: staff cannot write scheduled_messages themselves.

create or replace function public.cancel_messages_on_void()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.scheduled_messages
     set status = 'canceled'
   where booking_id = new.id
     and status = 'pending';
  return new;
end;
$$;

drop trigger if exists bookings_cancel_messages_on_void on public.bookings;
create trigger bookings_cancel_messages_on_void
  after update of voided_at on public.bookings
  for each row
  when (old.voided_at is null and new.voided_at is not null)
  execute function public.cancel_messages_on_void();

-- ── void_booking(): the one way a booking is voided ──────────────────────────
-- SECURITY INVOKER: the read and the update both run under the caller's RLS, so
-- a manager voids only their business's bookings and a check-in login only its
-- assigned tours. The reason is required and kept as typed. Failures raise a
-- short stable token the app maps to its own wording.

create or replace function public.void_booking(p_booking_id uuid, p_reason text)
returns table (voided_at timestamptz, voided_by_staff_id uuid, voided_by_name text)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_staff    uuid;
  v_role     public.staff_role;
  v_can_void boolean;
  v_status   public.booking_status;
  v_voided   timestamptz;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_now      timestamptz := now();
  v_rows     integer;
begin
  select cs.staff_id, cs.role, s.can_void_bookings
    into v_staff, v_role, v_can_void
    from public.current_staff() cs
    join public.staff s on s.id = cs.staff_id
   limit 1;
  if v_staff is null then
    raise exception 'not_staff';
  end if;
  if v_role <> 'owner' and not coalesce(v_can_void, false) then
    raise exception 'not_allowed';
  end if;
  if v_reason is null then
    raise exception 'reason_required';
  end if;

  select b.status, b.voided_at
    into v_status, v_voided
    from public.bookings b
   where b.id = p_booking_id;
  if not found then
    raise exception 'not_found';
  end if;
  if v_voided is not null then
    raise exception 'already_voided';
  end if;

  update public.bookings b
     set status             = 'cancelled',
         voided_at          = v_now,
         voided_by_staff_id = v_staff,
         void_reason        = left(v_reason, 500),
         voided_from_status = v_status
   where b.id = p_booking_id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'not_allowed';
  end if;

  return query
    select v_now, v_staff, s.full_name
      from public.staff s
     where s.id = v_staff;
end;
$$;

comment on function public.void_booking(uuid, text) is
  'Void a booking: status to cancelled plus the void stamp (who, when, why). The row stays. SECURITY INVOKER, so RLS scopes the caller; raises not_staff / not_allowed / reason_required / not_found / already_voided.';

revoke execute on function public.void_booking(uuid, text) from public, anon;
grant  execute on function public.void_booking(uuid, text) to authenticated;

-- ── restore_booking(): an owner undoes a void ────────────────────────────────
-- Puts the status back to what it was and clears the stamp. Owner only: a
-- restore puts guests back on a manifest, which is a bigger decision than the
-- void was. The activity log keeps both rows, so the story stays readable.

create or replace function public.restore_booking(p_booking_id uuid)
returns table (status public.booking_status)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_role   public.staff_role;
  v_voided timestamptz;
  v_from   public.booking_status;
  v_rows   integer;
begin
  select cs.role into v_role from public.current_staff() cs limit 1;
  if v_role is null then
    raise exception 'not_staff';
  end if;
  if v_role <> 'owner' then
    raise exception 'not_allowed';
  end if;

  select b.voided_at, b.voided_from_status
    into v_voided, v_from
    from public.bookings b
   where b.id = p_booking_id;
  if not found then
    raise exception 'not_found';
  end if;
  if v_voided is null then
    raise exception 'not_voided';
  end if;

  update public.bookings b
     set status             = coalesce(v_from, 'confirmed'),
         voided_at          = null,
         voided_by_staff_id = null,
         void_reason        = null,
         voided_from_status = null
   where b.id = p_booking_id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'not_allowed';
  end if;

  return query select coalesce(v_from, 'confirmed'::public.booking_status);
end;
$$;

comment on function public.restore_booking(uuid) is
  'Undo a void: status back to what it was, stamp cleared. Owner only. SECURITY INVOKER; raises not_staff / not_allowed / not_found / not_voided.';

revoke execute on function public.restore_booking(uuid) from public, anon;
grant  execute on function public.restore_booking(uuid) to authenticated;

-- ── /admin/payments: voided cash sales stay listed, stop counting ────────────
-- payments_scope grows two columns (voided_at, void_reason) and a 'voided'
-- effective_status, so the search word "voided" finds them and the row shows
-- the reason. payments_summary leaves them out of the cash total and count.
-- A return type cannot change under CREATE OR REPLACE, so the three are
-- dropped and recreated with the same signatures (20260811180000 is the base).

drop function if exists public.payments_feed(
  timestamptz, timestamptz, uuid, text, text, text, text, integer, integer
);
drop function if exists public.payments_summary(
  timestamptz, timestamptz, uuid, text, text, text, text
);
drop function if exists public.payments_scope(
  timestamptz, timestamptz, uuid, text, text, text, text
);

create or replace function public.payments_scope(
  p_start timestamptz,
  p_end timestamptz,
  p_business uuid default null,
  p_source text default null,
  p_q text default null,
  p_tender text default null,
  p_status text default null
)
returns table (
  kind text,
  id uuid,
  occurred_at timestamptz,
  business_id uuid,
  business_name text,
  amount integer,
  amount_refunded integer,
  currency text,
  status text,
  effective_status text,
  source text,
  source_original text,
  card_brand text,
  card_last4 text,
  stripe_id text,
  receipt_url text,
  customer_name text,
  customer_email text,
  booking_ref text,
  booking_id uuid,
  booking_starts_at timestamptz,
  voided_at timestamptz,
  void_reason text
)
language sql
stable
as $$
  select * from (
    select
      'card'::text            as kind,
      t.id                    as id,
      t.stripe_created        as occurred_at,
      t.business_id           as business_id,
      bz.name                 as business_name,
      t.amount                as amount,
      coalesce(t.amount_refunded, 0) as amount_refunded,
      t.currency              as currency,
      t.status                as status,
      -- What the row's badge shows, so a status search matches what staff read.
      case
        when t.status = 'disputed' then 'disputed'
        when coalesce(t.amount_refunded, 0) > 0
             and coalesce(t.amount_refunded, 0) >= t.amount then 'refunded'
        when coalesce(t.amount_refunded, 0) > 0 then 'partly_refunded'
        when t.status = 'succeeded' then 'succeeded'
        else coalesce(t.status, 'unknown')
      end                     as effective_status,
      t.source                as source,
      case when t.source_moved_at is not null then t.source_original end
                              as source_original,
      t.card_brand            as card_brand,
      t.card_last4            as card_last4,
      t.stripe_id             as stripe_id,
      t.receipt_url           as receipt_url,
      t.customer_name         as customer_name,
      t.customer_email        as customer_email,
      t.booking_ref           as booking_ref,
      t.booking_id            as booking_id,
      bk.starts_at            as booking_starts_at,
      null::timestamptz       as voided_at,
      null::text              as void_reason
    from public.stripe_transactions t
    left join public.businesses bz on bz.id = t.business_id
    left join public.bookings   bk on bk.id = t.booking_id
    where t.object_type = 'charge'
      and t.stripe_created between p_start and p_end
      and (p_business is null or t.business_id = p_business)
      and (p_source is null or t.source = p_source)
      and (
        p_q is null
        or t.customer_name  ilike '%' || p_q || '%'
        or t.customer_email ilike '%' || p_q || '%'
        or t.card_last4     ilike '%' || p_q || '%'
        or t.booking_ref    ilike '%' || p_q || '%'
      )

    union all

    select
      'cash'::text            as kind,
      c.id                    as id,
      c.created_at            as occurred_at,
      c.business_id           as business_id,
      bz.name                 as business_name,
      c.amount_cents          as amount,
      coalesce(c.amount_refunded_cents, 0) as amount_refunded,
      'usd'::text             as currency,
      'succeeded'::text       as status,
      case
        when c.voided_at is not null then 'voided'
        when coalesce(c.amount_refunded_cents, 0) > 0
             and coalesce(c.amount_refunded_cents, 0) >= coalesce(c.amount_cents, 0)
          then 'refunded'
        when coalesce(c.amount_refunded_cents, 0) > 0 then 'partly_refunded'
        else 'succeeded'
      end                     as effective_status,
      c.kiosk_slug            as source,
      case when c.source_moved_at is not null then c.kiosk_slug_original end
                              as source_original,
      null::text              as card_brand,
      null::text              as card_last4,
      null::text              as stripe_id,
      null::text              as receipt_url,
      nullif(btrim(cu.full_name), '') as customer_name,
      null::text              as customer_email,
      c.booking_ref           as booking_ref,
      bk.id                   as booking_id,
      bk.starts_at            as booking_starts_at,
      c.voided_at             as voided_at,
      c.void_reason           as void_reason
    from public.cash_sales c
    left join public.businesses bz on bz.id = c.business_id
    left join public.bookings   bk on bk.legacy_id = c.booking_ref
    left join public.customers  cu on cu.id = bk.customer_id
    where c.type = 'cash'
      and c.created_at between p_start and p_end
      and (p_business is null or c.business_id = p_business)
      and (p_source is null or c.kiosk_slug = p_source)
      and (
        p_q is null
        or c.booking_ref  ilike '%' || p_q || '%'
        or cu.full_name   ilike '%' || p_q || '%'
      )
  ) f
  where (p_tender is null or f.kind = p_tender)
    -- "refunded" is read as "has a refund", so it also catches partial ones;
    -- "partly_refunded" narrows to just those.
    and (
      p_status is null
      or f.effective_status = p_status
      or (p_status = 'refunded' and f.effective_status = 'partly_refunded')
    );
$$;

comment on function public.payments_scope(timestamptz, timestamptz, uuid, text, text, text, text) is
  'The filtered card + cash sale set behind /admin/payments. Shared by payments_feed (rows) and payments_summary (totals) so the two can never disagree. Voided cash sales are listed (effective_status = voided) and carry voided_at + void_reason. SECURITY INVOKER: RLS scopes by business.';

create or replace function public.payments_feed(
  p_start timestamptz,
  p_end timestamptz,
  p_business uuid default null,
  p_source text default null,
  p_q text default null,
  p_tender text default null,
  p_status text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  kind text,
  id uuid,
  occurred_at timestamptz,
  business_id uuid,
  business_name text,
  amount integer,
  amount_refunded integer,
  currency text,
  status text,
  source text,
  source_original text,
  card_brand text,
  card_last4 text,
  stripe_id text,
  receipt_url text,
  customer_name text,
  customer_email text,
  booking_ref text,
  booking_id uuid,
  booking_starts_at timestamptz,
  voided_at timestamptz,
  void_reason text,
  total_count bigint
)
language sql
stable
as $$
  select
    f.kind,
    f.id,
    f.occurred_at,
    f.business_id,
    f.business_name,
    f.amount,
    f.amount_refunded,
    f.currency,
    f.status,
    f.source,
    f.source_original,
    f.card_brand,
    f.card_last4,
    f.stripe_id,
    f.receipt_url,
    f.customer_name,
    f.customer_email,
    f.booking_ref,
    f.booking_id,
    f.booking_starts_at,
    f.voided_at,
    f.void_reason,
    count(*) over () as total_count
  from public.payments_scope(
    p_start, p_end, p_business, p_source, p_q, p_tender, p_status
  ) f
  order by f.occurred_at desc, f.id
  limit greatest(p_limit, 1)
  offset greatest(p_offset, 0);
$$;

comment on function public.payments_feed(timestamptz, timestamptz, uuid, text, text, text, text, integer, integer) is
  'One page of the payments feed, newest first, with the whole-scope row count in total_count. SECURITY INVOKER: RLS scopes by business.';

create or replace function public.payments_summary(
  p_start timestamptz,
  p_end timestamptz,
  p_business uuid default null,
  p_source text default null,
  p_q text default null,
  p_tender text default null,
  p_status text default null
)
returns table (
  card_gross bigint,
  card_count bigint,
  refunded bigint,
  cash_total bigint,
  cash_count bigint
)
language sql
stable
as $$
  select
    coalesce(sum(f.amount) filter (where f.kind = 'card'), 0)::bigint,
    count(*) filter (where f.kind = 'card')::bigint,
    coalesce(sum(f.amount_refunded), 0)::bigint,
    -- A voided cash sale is on the list for the record, not in the drawer.
    coalesce(sum(f.amount) filter (where f.kind = 'cash' and f.voided_at is null), 0)::bigint,
    count(*) filter (where f.kind = 'cash' and f.voided_at is null)::bigint
  from public.payments_scope(
    p_start, p_end, p_business, p_source, p_q, p_tender, p_status
  ) f;
$$;

comment on function public.payments_summary(timestamptz, timestamptz, uuid, text, text, text, text) is
  'Card + cash totals over the same scope the feed lists, aggregated in the DB. Card and cash are gross; refunded covers both tenders; voided cash sales are left out. SECURITY INVOKER: RLS scopes by business.';
