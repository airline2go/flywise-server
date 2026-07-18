-- ════════════════════════════════════════════════════════════
-- AIRPIV — Reclassify haul_type into three tiers (add Mittelstrecke)
-- Run once in Supabase's SQL Editor. Safe to re-run (idempotent).
-- ════════════════════════════════════════════════════════════
--
-- CONTEXT: haul_type used to be two-tier — anything >= 1500 km was
-- 'long-haul'. That mislabels medium-distance routes: Berlin↔Valencia
-- (~1790 km) showed up as a "Langstreckenflug" and got long-haul booking
-- advice. classifyHaul() in src/services/routePages.js is now three-tier:
--   short-haul  (Kurzstrecke):  < 1500 km
--   medium-haul (Mittelstrecke): 1500–4000 km
--   long-haul   (Langstrecke):  >= 4000 km
--
-- New routes get the correct value at creation time; this backfills every
-- existing row from its stored distance_km. Rows with a null distance_km
-- are left untouched (nothing to compute from). haul_type is a free-text
-- column (no CHECK constraint), so 'medium-haul' needs no schema change.
-- Mirrors classifyHaul() exactly — keep the two in sync.

update route_pages
set haul_type = case
  when distance_km < 1500 then 'short-haul'
  when distance_km < 4000 then 'medium-haul'
  else 'long-haul'
end
where distance_km is not null;
