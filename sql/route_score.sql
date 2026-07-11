-- ════════════════════════════════════════════════════════════
-- AIRPIV — Route Score (Phase 4A)
-- Run once in Supabase's SQL Editor. Safe to re-run (idempotent).
-- ════════════════════════════════════════════════════════════
--
-- CONTEXT: route_pages had no measure of real-world performance —
-- refresh_frequency (route_refresh_tier.sql) was, and for this phase
-- remains, 100% manually admin-set. route_score is the first computed,
-- traffic-derived signal, read from route_traffic_daily
-- (route_traffic.sql) by routeScore.js's hourly job. This phase is
-- read-only: the score is surfaced in the admin Route Pages list for
-- the admin to observe. Nothing in Phase 4A writes refresh_frequency
-- based on it — that's Phase 4B, and only after this data has been
-- watched against real traffic for a meaningful window.
--
-- route_score_confidence exists because a score built on a handful of
-- impressions makes a much weaker claim than the same score built on
-- thousands — shown alongside the score so thin data is never read as
-- equivalent to well-observed data.
-- ════════════════════════════════════════════════════════════

alter table route_pages add column if not exists route_score numeric;
alter table route_pages add column if not exists route_score_updated_at timestamptz;
alter table route_pages add column if not exists route_score_confidence text
  check (route_score_confidence in ('low', 'medium', 'high'));

create index if not exists route_pages_route_score_idx on route_pages (route_score);

select 'route score migration applied!' as status;
