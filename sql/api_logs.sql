-- ════════════════════════════════════════════════════════════
-- AIRPIV — Duffel API request logging (cost/usage monitoring)
-- Run once in Supabase's SQL Editor. Safe to re-run (idempotent).
-- ════════════════════════════════════════════════════════════
--
-- CONTEXT: every Duffel call went unrecorded — no way to see how much
-- traffic the platform generates, which routes drive it, or whether
-- usage is trending toward a rate-limit problem. One row per logical
-- Duffel operation (via the shared duffel() wrapper in
-- src/services/duffel.js — retries within one call collapse to a
-- single row, and the isolated duffelAttempt() health-check path is
-- deliberately excluded, same reasoning as its circuit-breaker
-- isolation). route_origin/route_destination are only ever set for
-- the route-pricing call sites (warming + on-demand GET /route-price)
-- — every other Duffel call (booking, cancellation, etc.) leaves them
-- null, by design; see the "Explicitly out of scope" note in the
-- implementation plan for why booking-flow calls aren't route-tagged.
--
-- RLS: server-only — zero policies for anon/authenticated, same
-- pattern as admin_activity_log/error_logs.
-- ════════════════════════════════════════════════════════════

create table if not exists api_logs (
  id uuid primary key default gen_random_uuid(),
  method text not null,
  endpoint text not null,
  category text not null check (category in ('search', 'booking', 'other')),
  status_code int,
  success boolean not null,
  duration_ms int,
  route_origin text,
  route_destination text,
  created_at timestamptz not null default now()
);
create index if not exists api_logs_created_at_idx on api_logs (created_at);
create index if not exists api_logs_category_idx on api_logs (category);
create index if not exists api_logs_route_idx on api_logs (route_origin, route_destination);

alter table api_logs enable row level security;
-- Deliberately no insert/select/update/delete policy for anon/authenticated —
-- every access goes through flywise-server's service-role key only.

select 'api request logging migration applied!' as status;
