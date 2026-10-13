-- A business manager can be given tours they see from EVERY business, the way a
-- check-in desk already sees its tours (staff_tours, the same table). First use:
-- Miami Skyline's manager runs the Jet Ski, but a few of its bookings arrive under
-- Key West Sightseeing Tours or Miami Jet Ski Tours and were invisible to them.
--
-- For a tour in their staff_tours a manager now:
--   * reads and updates every business's bookings on it (each update still gated by
--     the staff.can_* switches and the capability trigger, exactly as a check-in desk);
--   * reads the other businesses' copies of the tour, their prices and their names,
--     so the bookings screen can name and filter those bookings;
--   * reads the guests on those bookings, and only those guests (a check-in desk reads
--     the other business's whole guest list; a manager has a Customers screen, so the
--     other business's customers stay out of it).
-- Creating bookings stays on their own business (bookings_insert is untouched).
--
-- Only the owner grants it. staff_tours_write let a manager write rows for anyone in
-- their business, themselves included, which would now widen their own access, so
-- its manager branch is narrowed to their check-in logins.

-- ── Who may assign tours ─────────────────────────────────────────────────────────

drop policy if exists staff_tours_write on public.staff_tours;
create policy staff_tours_write
  on public.staff_tours for all to authenticated
  using (
    exists (
      select 1 from public.staff s, public.current_staff() cs
      where s.id = staff_tours.staff_id
        and (cs.role = 'owner'
             or (cs.role = 'business_manager' and cs.business_id = s.business_id
                 and s.role = 'check_in'))
    )
  )
  with check (
    exists (
      select 1 from public.staff s, public.current_staff() cs
      where s.id = staff_tours.staff_id
        and (cs.role = 'owner'
             or (cs.role = 'business_manager' and cs.business_id = s.business_id
                 and s.role = 'check_in'))
    )
  );

-- ── Bookings ─────────────────────────────────────────────────────────────────────

drop policy if exists bookings_select on public.bookings;
create policy bookings_select
  on public.bookings for select to public
  using (
    exists (
      select 1 from public.current_staff() cs
      where cs.role = 'owner'
         or (cs.role = 'business_manager' and cs.business_id = bookings.business_id)
         or (cs.role in ('check_in', 'business_manager') and exists (
               select 1
               from public.staff_tours st
               join public.business_tours bt on bt.tour_id = st.tour_id
               where st.staff_id = cs.staff_id and bt.id = bookings.business_tour_id))
    )
    and not (awaiting_payment and paid_at is null and status = 'pending')
  );

drop policy if exists bookings_update on public.bookings;
create policy bookings_update
  on public.bookings for update to authenticated
  using (
    exists (
      select 1
      from public.current_staff() cs
      join public.staff s on s.id = cs.staff_id
      where cs.role = 'owner'
         or ((s.can_edit_bookings or s.can_check_in or s.can_add_to_peek
              or s.can_redeem_groupon or s.can_void_bookings)
             and ((cs.role = 'business_manager' and cs.business_id = bookings.business_id)
                  or (cs.role in ('check_in', 'business_manager') and exists (
                        select 1
                        from public.staff_tours st
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
         or ((s.can_edit_bookings or s.can_check_in or s.can_add_to_peek
              or s.can_redeem_groupon or s.can_void_bookings)
             and ((cs.role = 'business_manager' and cs.business_id = bookings.business_id)
                  or (cs.role in ('check_in', 'business_manager') and exists (
                        select 1
                        from public.staff_tours st
                        join public.business_tours bt on bt.tour_id = st.tour_id
                        where st.staff_id = cs.staff_id
                          and bt.id = bookings.business_tour_id))))
    )
  );

-- ── The other copies of the tour, their prices and business names ────────────────

drop policy if exists business_tours_select on public.business_tours;
create policy business_tours_select
  on public.business_tours for select to authenticated
  using (
    exists (
      select 1 from public.current_staff() cs
      where cs.role = 'owner'
         or (cs.role in ('business_manager', 'check_in') and cs.business_id = business_tours.business_id)
         or (cs.role in ('business_manager', 'check_in') and exists (
               select 1 from public.staff_tours st
               where st.staff_id = cs.staff_id and st.tour_id = business_tours.tour_id))
    )
  );

drop policy if exists tour_pax_tiers_select on public.tour_pax_tiers;
create policy tour_pax_tiers_select
  on public.tour_pax_tiers for select to authenticated
  using (
    exists (
      select 1
      from public.business_tours bt, public.current_staff() cs
      where bt.id = tour_pax_tiers.business_tour_id
        and (cs.role = 'owner'
             or (cs.role in ('business_manager', 'check_in') and cs.business_id = bt.business_id)
             or (cs.role in ('business_manager', 'check_in') and exists (
                   select 1 from public.staff_tours st
                   where st.staff_id = cs.staff_id and st.tour_id = bt.tour_id)))
    )
  );

drop policy if exists businesses_select on public.businesses;
create policy businesses_select
  on public.businesses for select to authenticated
  using (
    exists (
      select 1 from public.current_staff() cs
      where cs.role = 'owner'
         or cs.business_id = businesses.id
         or (cs.role in ('business_manager', 'check_in') and exists (
               select 1
               from public.business_tours bt
               join public.staff_tours st on st.tour_id = bt.tour_id
               where st.staff_id = cs.staff_id and bt.business_id = businesses.id))
    )
  );

-- ── The guests on those bookings ─────────────────────────────────────────────────

-- The other businesses' guests a manager may read: those booked on one of their
-- shared tours. SECURITY DEFINER so the policy does not re-run bookings RLS per
-- customer row; it takes the caller from current_staff(), so it can only ever answer
-- for the signed-in manager. Called uncorrelated in customers_select, so Postgres
-- computes the set once per query, not once per customer.
create or replace function public.manager_shared_guest_ids()
returns setof uuid
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select bk.customer_id
  from public.current_staff() cs
  join public.staff_tours st on st.staff_id = cs.staff_id
  join public.business_tours bt
    on bt.tour_id = st.tour_id and bt.business_id is distinct from cs.business_id
  join public.bookings bk on bk.business_tour_id = bt.id
  where cs.role = 'business_manager'
    and bk.customer_id is not null
$$;

revoke all on function public.manager_shared_guest_ids() from public, anon;
grant execute on function public.manager_shared_guest_ids() to authenticated;

drop policy if exists customers_select on public.customers;
create policy customers_select
  on public.customers for select to authenticated
  using (
    exists (
      select 1 from public.current_staff() cs
      where cs.role = 'owner'
         or (cs.role in ('business_manager', 'check_in') and cs.business_id = customers.business_id)
         or (cs.role = 'check_in' and exists (
               select 1
               from public.business_tours bt
               join public.staff_tours st on st.tour_id = bt.tour_id
               where st.staff_id = cs.staff_id and bt.business_id = customers.business_id))
    )
    or customers.id in (select public.manager_shared_guest_ids())
  );
