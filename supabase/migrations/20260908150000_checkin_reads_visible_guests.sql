-- Follow-up to checkin_sees_all_copies. A check-in login can see another business's
-- bookings on its tours, but that business's guest rows were still hidden by
-- customers_select, so the bookings screen dropped those bookings (the guest is an
-- inner part of the row it renders). First seen on rollout day: a kiosk cash sale
-- on Miami Skyline's combo tour never showed for the Key West desk.
--
-- A check-in login can now read the guests of every business that owns a copy of a
-- tour it is assigned to, the same rule the businesses policy uses. Read only.

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
  );
