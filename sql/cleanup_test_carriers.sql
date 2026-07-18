-- ════════════════════════════════════════════════════════════
-- AIRPIV — Cleanup: remove test-mode / placeholder carriers
-- Run once in Supabase's SQL Editor. Safe to re-run (idempotent).
-- ════════════════════════════════════════════════════════════
--
-- CONTEXT: while a Duffel TEST token was in use, every offer carried the
-- synthetic carrier "Duffel Airways" (IATA "ZZ"). ensureAirlineExists()
-- persisted it into `airlines`, ensureRouteAirlineObserved() recorded it in
-- `route_airlines`, and it leaked onto public airline/route pages. The
-- ingestion path now filters these out defensively (see
-- src/services/carrierFilter.js), but rows written BEFORE that fix are
-- still in the database and will not clean themselves up. This removes them.
--
-- Mirrors src/services/carrierFilter.js exactly — keep the two in sync:
--   excluded IATA codes: 'ZZ', 'XX'
--   excluded names (case-insensitive): 'Duffel Airways', 'Unknown'
--
-- `route_airlines.airline_id` is `references airlines(id) on delete cascade`
-- (see airlines.sql), so deleting the airline rows automatically removes
-- every matching route_airlines row too — no separate delete needed.
--
-- route_pages.airline_count is NOT touched here: it is recomputed hourly
-- from route_airlines by src/services/routeIntelligenceRefresh.js, so it
-- self-corrects within the hour once the route_airlines rows are gone. To
-- force it immediately, restart the server (the refresh runs 60s after
-- boot) or run the manual recompute at the bottom of this file.

-- Show what will be removed (run this SELECT first to eyeball it):
--   select id, iata_code, name from airlines
--   where upper(iata_code) in ('ZZ', 'XX')
--      or lower(name) in ('duffel airways', 'unknown');

delete from airlines
where upper(iata_code) in ('ZZ', 'XX')
   or lower(name) in ('duffel airways', 'unknown');

-- OPTIONAL — force an immediate airline_count recompute instead of waiting
-- for the hourly refresh. Sets every route's count to the number of DISTINCT
-- remaining airlines observed on it (0 where none remain). Identical result
-- to routeIntelligenceRefresh.js's computeAirlineCounts().
update route_pages rp
set airline_count = coalesce(sub.cnt, 0)
from (
  select route_origin_iata, route_destination_iata, count(distinct airline_id) as cnt
  from route_airlines
  group by route_origin_iata, route_destination_iata
) sub
where rp.origin_iata = sub.route_origin_iata
  and rp.destination_iata = sub.route_destination_iata;

-- Any route that had ONLY the removed carrier now has no route_airlines
-- rows at all, so the join above won't reach it — reset those to 0 too.
update route_pages rp
set airline_count = 0
where not exists (
  select 1 from route_airlines ra
  where ra.route_origin_iata = rp.origin_iata
    and ra.route_destination_iata = rp.destination_iata
);
