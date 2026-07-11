-- ════════════════════════════════════════════════════════════
-- AIRPIV — Route Intelligence Data Core (Phase 1)
-- Run once in Supabase's SQL Editor. Safe to re-run (idempotent).
-- ════════════════════════════════════════════════════════════
--
-- CONTEXT: fetchAndCacheRoutePrice() (search.routes.js) already computes
-- a rich `insights` object from every live Duffel offer-request —
-- avgDurationMin, minDurationMin, directAvailable, allDirect, airlines —
-- but it only ever lives inside a single /route-price response and the
-- admin_config price cache, which OVERWRITES on every fetch. None of it
-- was ever persisted back onto route_pages, so the SSG build (which
-- reads route_pages via GET /route-pages/:slug's `select('*')`) never
-- saw it. This migration adds columns to receive that same data as a
-- durable per-route signal, so it survives beyond a single request and
-- reaches build-time template rendering.
--
-- airline_count is intentionally NOT capped at 8 like the ephemeral
-- insights.airlines list — it's recomputed by routeIntelligenceRefresh.js
-- from the already-accumulating route_airlines table (airlines.sql),
-- which observes every airline ever seen on a route, not just the last
-- search's top 8.
-- ════════════════════════════════════════════════════════════

alter table route_pages add column if not exists direct_flight_available boolean;
alter table route_pages add column if not exists all_direct boolean;
alter table route_pages add column if not exists avg_duration_min int;
alter table route_pages add column if not exists min_duration_min int;
alter table route_pages add column if not exists stop_distribution jsonb;
alter table route_pages add column if not exists airline_count int;
alter table route_pages add column if not exists insights_updated_at timestamptz;

select 'route intelligence data core migration applied!' as status;
