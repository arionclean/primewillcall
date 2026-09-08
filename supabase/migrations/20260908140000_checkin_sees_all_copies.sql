-- A check-in login sees bookings on its assigned tours from EVERY business (the
-- bookings_select policy keys on staff_tours, not on the business), because one desk
-- checks in Key West's and Miami Skyline's guests alike. But the tour rows behind
-- those bookings were still scoped to the login's own business, so the bookings
-- screen could not name the other business's copy of a tour, its tour filter only
-- knew one business's copies (filtering by "Miami 5 in 1 City Tour" hid the other
-- business's guests on it), and pricing tiers of the other copy were unreadable.
--
-- Now a check-in login can also read the other businesses' copies of its assigned
-- tours, those businesses' names, and the tiers of those copies. Read only; every
-- write policy is untouched. Managers keep their single business.

drop policy if exists business_tours_select on public.business_tours;
create policy business_tours_select
  on public.business_tours for select to authenticated
  using (
    exists (
      select 1 from public.current_staff() cs
      where cs.role = 'owner'
         or (cs.role in ('business_manager', 'check_in') and cs.business_id = business_tours.business_id)
         or (cs.role = 'check_in' and exists (
               select 1 from public.staff_tours st
               where st.staff_id = cs.staff_id and st.tour_id = business_tours.tour_id))
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
         or (cs.role = 'check_in' and exists (
               select 1
               from public.business_tours bt
               join public.staff_tours st on st.tour_id = bt.tour_id
               where st.staff_id = cs.staff_id and bt.business_id = businesses.id))
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
             or (cs.role = 'check_in' and exists (
                   select 1 from public.staff_tours st
                   where st.staff_id = cs.staff_id and st.tour_id = bt.tour_id)))
    )
  );
