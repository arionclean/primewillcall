-- Groupon /gp shadow test: store one row per real Xano voucher, with Xano's
-- verdict and ours side by side.
--
-- The point is to keep grading the Supabase matcher against live Xano traffic
-- until we trust it enough to cut /gp over. A one-shot replay already caught a
-- competitor's voucher being matched to a Miami product and two deals that Xano
-- rejects and we handle, but a replay only reaches the ~30 requests Xano still
-- has in its rolling history. This table is fed continuously instead.
--
-- Xano is never written to. Rows arrive either as a push from Xano's existing
-- post_process hook or from a replay run; `source` records which.

create table if not exists public.gp_shadow_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  source text not null default 'xano_push' check (source in ('xano_push', 'replay')),

  -- Idempotency. Xano's request id when pushed, the multimedia row id on replay.
  xano_ref text unique,
  xano_image_url text,
  voucher_image_path text, -- our copy under the gp-vouchers bucket

  -- What live Xano decided.
  xano_product text,
  xano_fee_cents integer,
  xano_passengers integer,
  xano_voucher_code text,
  xano_match_score numeric,

  -- What we decided.
  ours_business_tour_id uuid references public.business_tours(id) on delete set null,
  ours_product text,
  ours_fee_cents integer,
  ours_passengers integer,
  ours_voucher_code text,
  ours_match_method text, -- title | fuzzy | merchant | ai | null
  ours_reason text,
  ours_merchant_seen boolean,
  ours_ms integer,

  -- agree            both picked the same product
  -- different_product both picked, and they disagree      <- the one that matters
  -- ours_only        we matched, Xano did not
  -- xano_only        Xano matched, we did not
  -- both_none        neither matched (usually a competitor's voucher)
  -- error            the replay itself failed
  verdict text not null check (verdict in
    ('agree', 'different_product', 'ours_only', 'xano_only', 'both_none', 'error')),
  fee_matches boolean,
  passengers_match boolean,
  error text,

  -- Owner notes while reviewing a disagreement.
  reviewed_at timestamptz,
  review_note text
);

create index if not exists gp_shadow_runs_created_idx on public.gp_shadow_runs (created_at desc);
create index if not exists gp_shadow_runs_verdict_idx on public.gp_shadow_runs (verdict, created_at desc);

alter table public.gp_shadow_runs enable row level security;

-- Owner-only. This is platform QA data spanning every business, and it carries
-- OCR-derived voucher detail, so managers and kiosks have no business in it.
-- The edge function writes with the service role, which bypasses RLS.
drop policy if exists gp_shadow_runs_owner_select on public.gp_shadow_runs;
create policy gp_shadow_runs_owner_select on public.gp_shadow_runs
  for select to authenticated
  using (exists (select 1 from public.current_staff() cs where cs.role = 'owner'));

drop policy if exists gp_shadow_runs_owner_update on public.gp_shadow_runs;
create policy gp_shadow_runs_owner_update on public.gp_shadow_runs
  for update to authenticated
  using      (exists (select 1 from public.current_staff() cs where cs.role = 'owner'))
  with check (exists (select 1 from public.current_staff() cs where cs.role = 'owner'));

-- Aggregated in the database, not in JS: a single read caps at 1000 rows and the
-- shadow table grows without bound.
create or replace function public.gp_shadow_summary(
  p_from timestamptz default now() - interval '30 days',
  p_to timestamptz default now()
)
returns table (
  total bigint,
  agree bigint,
  different_product bigint,
  ours_only bigint,
  xano_only bigint,
  both_none bigint,
  errors bigint,
  fee_mismatches bigint,
  passenger_mismatches bigint,
  tier_title bigint,
  tier_fuzzy bigint,
  tier_merchant bigint,
  tier_ai bigint,
  tier_none bigint,
  median_ms integer
)
language sql
stable
security invoker
set search_path to 'pg_catalog', 'public'
as $$
  select
    count(*),
    count(*) filter (where verdict = 'agree'),
    count(*) filter (where verdict = 'different_product'),
    count(*) filter (where verdict = 'ours_only'),
    count(*) filter (where verdict = 'xano_only'),
    count(*) filter (where verdict = 'both_none'),
    count(*) filter (where verdict = 'error'),
    count(*) filter (where fee_matches is false),
    count(*) filter (where passengers_match is false),
    count(*) filter (where ours_match_method = 'title'),
    count(*) filter (where ours_match_method = 'fuzzy'),
    count(*) filter (where ours_match_method = 'merchant'),
    count(*) filter (where ours_match_method = 'ai'),
    count(*) filter (where ours_match_method is null),
    percentile_cont(0.5) within group (order by ours_ms)::integer
  from public.gp_shadow_runs
  where created_at >= p_from and created_at < p_to;
$$;

grant execute on function public.gp_shadow_summary(timestamptz, timestamptz) to authenticated, service_role;

comment on table public.gp_shadow_runs is
  'Shadow test of the Supabase /gp voucher matcher against live Xano verdicts. Read-only with respect to Xano.';
