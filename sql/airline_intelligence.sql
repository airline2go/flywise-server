-- ════════════════════════════════════════════════════════════
-- AIRPIV — Airline Intelligence (Phase 3)
-- Run once in Supabase's SQL Editor. Safe to re-run (idempotent).
-- ════════════════════════════════════════════════════════════
--
-- CONTEXT: GET /airlines/:code (content.routes.js) infers a hub airport
-- from the already-accumulated route_airlines observation table (the
-- IATA code appearing most often as origin or destination across that
-- airline's observed routes) — but inference can be wrong or incomplete
-- for an airline with too few observations yet. hub_iata is an optional
-- admin override that, when set, always wins over the inferred value.
-- country_code is a plain admin-authored fact — airline nationality is
-- never inferable from route_airlines observations, only ever knowable
-- from an external source (an admin typing it in, same as
-- ensureAirlineExists()'s auto-created rows never set it).
-- ════════════════════════════════════════════════════════════

alter table airlines add column if not exists country_code text;
alter table airlines add column if not exists hub_iata text;

select 'airline intelligence migration applied!' as status;
