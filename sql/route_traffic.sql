-- ════════════════════════════════════════════════════════════
-- AIRPIV — Route page traffic tracking (Phase 4A)
-- Run once in Supabase's SQL Editor. Safe to re-run (idempotent).
-- ════════════════════════════════════════════════════════════
--
-- CONTEXT: route pages had zero first-party interaction signal — the
-- only existing analytics event (gtag 'route_page_view') lives solely
-- in Google Analytics and isn't queryable server-side. This is the
-- tracking pipeline Route Score (route_score.sql) reads from, and
-- eventually — once observed and trusted, per Phase 4B — the input
-- budget automation ranks routes against.
--
-- Three event types, deliberately no more: 'impression' (route page
-- viewed), 'click' (the page's single primary CTA clicked), and
-- 'booking_start' (the visitor's browser actually reached
-- /search/{IATA}-{IATA} — real intent, not just a click). No IP, no
-- user-agent, no cookie/session id is ever stored — no-PII by
-- construction, not by redaction.
--
-- route_traffic_events is the raw log; route_traffic_daily is the
-- rollup routeScore.js actually reads. Raw rows get pruned after 90
-- days by routeTraffic.js's daily job — the rollup itself is never
-- pruned, kept permanently as the long-term record.
--
-- RLS: server-only — zero policies for anon/authenticated, same
-- pattern as api_logs/admin_activity_log/error_logs.
-- ════════════════════════════════════════════════════════════

create table if not exists route_traffic_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in ('impression', 'click', 'booking_start')),
  route_slug text,
  origin_iata text,
  destination_iata text,
  language text,
  created_at timestamptz not null default now()
);
create index if not exists route_traffic_events_created_at_idx on route_traffic_events (created_at);
create index if not exists route_traffic_events_slug_idx on route_traffic_events (route_slug);
create index if not exists route_traffic_events_route_idx on route_traffic_events (origin_iata, destination_iata);

alter table route_traffic_events enable row level security;
-- Deliberately no insert/select/update/delete policy for anon/authenticated —
-- every access goes through flywise-server's service-role key only, even
-- though the /track/route-page endpoint itself is publicly reachable
-- (the insert happens server-side after that endpoint's own rate
-- limiting + bot filter, never directly from the browser to Supabase).

create table if not exists route_traffic_daily (
  route_slug text not null,
  day date not null,
  impressions int not null default 0,
  clicks int not null default 0,
  booking_starts int not null default 0,
  primary key (route_slug, day)
);
create index if not exists route_traffic_daily_day_idx on route_traffic_daily (day);

alter table route_traffic_daily enable row level security;
-- Same posture — service-role only.

select 'route traffic tracking migration applied!' as status;
