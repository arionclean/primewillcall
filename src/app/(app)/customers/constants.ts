/**
 * Shared by the server page and the client list, so it must NOT live in
 * `list.tsx`.
 *
 * `list.tsx` is a `"use client"` module. When a server component imports a
 * value from one, Next hands back a client reference, not the value. That is
 * silent for a plain constant: `.limit(CUSTOMERS_PAGE)` on the server stopped
 * being a limit at all, so the page fetched Supabase's default cap of 1000 rows
 * and shipped roughly 290 KB per visit instead of 27 KB. It also broke paging,
 * because the client compares `initial.length === CUSTOMERS_PAGE` to decide
 * whether to offer "Load more", and 1000 never equals 50.
 */
export const CUSTOMERS_PAGE = 50;
