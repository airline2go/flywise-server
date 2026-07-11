-- ════════════════════════════════════════════════════════════
-- AIRPIV — Airport Intelligence (Phase 3)
-- Run once in Supabase's SQL Editor. Safe to re-run (idempotent).
-- ════════════════════════════════════════════════════════════
--
-- CONTEXT: airports (geo_i18n.sql) only ever carried identity-level
-- data (iata_code/icao_code/airport_name/city_id/country_code/lat/lng).
-- None of this is derivable from Duffel observations or auto-inferred —
-- it's genuine traveler-facing knowledge (how far is the airport from
-- downtown, how do you get there, what should you know before you
-- arrive) that only an admin can author. All four columns are optional
-- and additive — render-airport.js simply omits the corresponding
-- section when a field is null, so no existing airport page regresses.
-- ════════════════════════════════════════════════════════════

alter table airports add column if not exists distance_to_city_center_km numeric;
alter table airports add column if not exists transit_options text;
alter table airports add column if not exists terminal_info text;
alter table airports add column if not exists traveler_tips text;

select 'airport intelligence migration applied!' as status;
