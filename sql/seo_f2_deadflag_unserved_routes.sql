-- ════════════════════════════════════════════════════════════
-- AIRPIV — F2: dead-flag Category-C "unserved-airport" routes
-- Recovery plan phase 4/5 · RCA: docs/RCA-ROUTE-DATA-2026-09.md
-- Run once in Supabase's SQL Editor. Idempotent (safe to re-run).
-- ════════════════════════════════════════════════════════════
--
-- CONTEXT: 595 published routes have airline_count=0 and ZERO rows in
-- route_airlines. RCA split them:
--   • Category C (275) — at least one endpoint airport is NEVER present in
--     route_airlines anywhere (XFW Hamburg-Finkenwerder, DWC Dubai World
--     Central, TOJ Madrid-Torrejón, NRN Weeze, KSF Kassel, …). These airports
--     carry no scheduled passenger service in our data, so a "flights from X"
--     page for them is a permanent zero-flights page — not a temporary gap.
--   • Category D (320) — both airports ARE served elsewhere; this specific pair
--     just has no flights yet. Those are handled by a SEPARATE backfill (F3),
--     NOT here (plan rule #3: no blind noindex of a maybe-real route).
--
-- POLICY (clear + testable, plan rule #8): a route whose origin OR destination
-- airport never appears in route_airlines is unserved → status='dead'. The
-- public route endpoint filters status='published', so a 'dead' route leaves
-- the site + sitemap immediately (and the frontend already 301s the handful of
-- exact-duplicate slugs among them — F1). 'dead' is the SAME status the
-- existing health-check reaper uses; no schema change (route_pages.status has
-- no CHECK constraint).
--
-- DRY-RUN (verified 2026-09-04): this touches exactly 275 rows. Re-run the
-- SELECT below before applying to confirm the count still matches your review.
--
-- REVERSIBLE: the rollback block at the bottom re-publishes exactly the
-- Category-C set. At apply time no route was 'dead' (already_dead=0), so the
-- forward change is fully undoable; the rollback is scoped to Category C so it
-- never touches a genuinely-dead served route.

-- ── DRY-RUN (read-only) — confirm the target set before applying ────────────
-- WITH served AS (
--   SELECT route_origin_iata AS c FROM route_airlines
--   UNION SELECT route_destination_iata FROM route_airlines
-- )
-- SELECT count(*) AS will_change
-- FROM route_pages
-- WHERE status = 'published' AND coalesce(airline_count, 0) = 0
--   AND (origin_iata NOT IN (SELECT c FROM served)
--        OR destination_iata NOT IN (SELECT c FROM served));   -- expect 275

-- ── FORWARD — dead-flag Category C ──────────────────────────────────────────
WITH served AS (
  SELECT route_origin_iata AS c FROM route_airlines
  UNION SELECT route_destination_iata FROM route_airlines
)
UPDATE route_pages
SET status = 'dead', updated_at = now()
WHERE status = 'published' AND coalesce(airline_count, 0) = 0
  AND (origin_iata NOT IN (SELECT c FROM served)
       OR destination_iata NOT IN (SELECT c FROM served));

-- ── ROLLBACK — re-publish the Category-C set (run only to undo) ──────────────
-- WITH served AS (
--   SELECT route_origin_iata AS c FROM route_airlines
--   UNION SELECT route_destination_iata FROM route_airlines
-- )
-- UPDATE route_pages
-- SET status = 'published', updated_at = now()
-- WHERE status = 'dead' AND coalesce(airline_count, 0) = 0
--   AND (origin_iata NOT IN (SELECT c FROM served)
--        OR destination_iata NOT IN (SELECT c FROM served));
