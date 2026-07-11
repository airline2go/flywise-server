-- ════════════════════════════════════════════════════════════
-- AIRPIV — Airline pages: new entity type
-- Run once in Supabase's SQL Editor. Safe to re-run (idempotent).
-- ════════════════════════════════════════════════════════════
--
-- CONTEXT: airline names/IATA codes are observed live from Duffel offers
-- (segments[].marketing_carrier) on every /route-price call but were
-- never persisted anywhere — the "airlines flying this route" line on
-- route pages was recomputed client-side from a single live search each
-- page view, and there was no dedicated airline page at all. This adds
-- an `airlines` table (auto-populated the same way cities/countries/
-- airports already are, via ensureAirlineExists() in routePages.js) plus
-- a `route_airlines` join table recording which airlines have actually
-- been observed operating which route — the real, accumulated-over-time
-- source of truth for both the route page's airline list and each new
-- airline page's "routes operated" list.
--
-- No `airline_translations` table: airline names are non-localized
-- proper nouns (same choice already made for `code`/`iata_code` on
-- airports) — the single `name` column applies across every language.

create table if not exists airlines (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  iata_code text unique not null,                -- e.g. "LH"
  name text not null,                             -- e.g. "Lufthansa"
  intro_text text,                                -- optional hand-written SEO paragraph; falls back to a generic template if empty
  status text not null default 'published' check (status in ('draft','published'))
);
create index if not exists airlines_status_idx on airlines (status);

alter table airlines enable row level security;
drop policy if exists "Public can read published airlines" on airlines;
create policy "Public can read published airlines"
  on airlines for select
  using (status = 'published');

-- [ROUTE-AIRLINES-OBSERVED] One row per (route, airline) pair ever seen
-- together in a live Duffel search — grows over time exactly like
-- cities.airport_codes, never overwritten. last_seen_at lets a rarely-
-- flown historical airline eventually be distinguished from one that's
-- currently active on a route, without deleting the observation.
create table if not exists route_airlines (
  id uuid primary key default gen_random_uuid(),
  route_origin_iata text not null,
  route_destination_iata text not null,
  airline_id uuid not null references airlines(id) on delete cascade,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (route_origin_iata, route_destination_iata, airline_id)
);
create index if not exists route_airlines_route_idx on route_airlines (route_origin_iata, route_destination_iata);
create index if not exists route_airlines_airline_idx on route_airlines (airline_id);

-- [RLS-SECURITY-FIX] Enabled immediately, service-role only (this table
-- is never read directly by the public API — content.routes.js joins
-- through it server-side) — same pattern as api_logs/route_traffic_events.
alter table route_airlines enable row level security;
