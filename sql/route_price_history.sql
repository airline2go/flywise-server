-- ════════════════════════════════════════════════════════════
-- AIRPIV — Route price history (Phase: economic intelligence)
-- Run once in Supabase's SQL Editor. Safe to re-run (idempotent).
-- ════════════════════════════════════════════════════════════
--
-- CONTEXT: fetchAndCacheRoutePrice() (search.routes.js) computes a real
-- "from" price for a route on every warm/on-demand pricing call, but that
-- number only ever lived in the admin_config price cache, which OVERWRITES
-- on every fetch — so there was no history to compute a price RANGE, a
-- cheapest-ever fare, or a price TREND from. routeIntelligence.js's
-- `economic` snapshot was therefore hard-coded to null.
--
-- This adds:
--   1. route_price_history — one row per observed price point (append-only).
--   2. Aggregate columns on route_pages, filled periodically by
--      src/services/routePriceHistoryRefresh.js from the trailing window of
--      route_price_history, plus itinerary_count written inline by
--      fetchAndCacheRoutePrice() (the live offer count for the last search).
--
-- Every value is a real observation — never an estimate. A route with no
-- price points simply has null aggregates and its economic snapshot stays
-- null, exactly as before.

create table if not exists route_price_history (
  id uuid primary key default gen_random_uuid(),
  route_origin_iata text not null,
  route_destination_iata text not null,
  price numeric not null,                 -- the customer-facing "from" price (net + margin)
  currency text not null default 'EUR',
  offer_count int,                        -- number of itineraries seen in that search (nullable — older rows may lack it)
  observed_at timestamptz not null default now()
);

-- Hot path: "give me this route's points newest-first within a window".
create index if not exists route_price_history_route_time_idx
  on route_price_history (route_origin_iata, route_destination_iata, observed_at desc);

-- Aggregates on route_pages (mirrors route_intelligence.sql's additive style).
alter table route_pages add column if not exists price_min numeric;
alter table route_pages add column if not exists price_avg numeric;
alter table route_pages add column if not exists price_max numeric;
alter table route_pages add column if not exists price_currency text;
alter table route_pages add column if not exists price_sample_count int;
alter table route_pages add column if not exists itinerary_count int;
-- 'down' | 'up' | 'stable' — trailing-window trend, null until enough samples.
alter table route_pages add column if not exists price_trend text;
alter table route_pages add column if not exists price_updated_at timestamptz;

-- [RLS] route_price_history is written and read server-side only (via the
-- service-role Supabase client), like route_airlines — no public policies.
alter table route_price_history enable row level security;

select 'route price history migration applied!' as status;
