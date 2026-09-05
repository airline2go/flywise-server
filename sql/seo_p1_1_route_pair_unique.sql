-- ═══════════════════════════════════════════════════════════════════════
-- seo_p1_1_route_pair_unique.sql  (P1-1)  ⚠️ NOT YET APPLIED — NEEDS APPROVAL
-- ─────────────────────────────────────────────────────────────────────────
-- Prevents duplicate PUBLISHED (origin_iata, destination_iata) route pages at
-- the DB level (application-level checks can't stop a race). Two steps, in order:
--
--   1. Delete the 10 duplicate LOSER rows. This is SAFE ONLY because P0-4 made
--      their loser→winner 301s persistent in route_redirects — deleting the
--      route_pages row leaves the old URL still 301-ing to the canonical winner
--      (verified: 10 redirects, all targets are published winners). Guard: only
--      delete a row that (a) is a redirect source AND (b) whose redirect target
--      still exists as a published winner — so a missing/typo redirect can never
--      delete a page that would then 404.
--   2. Add a PARTIAL unique index on (origin_iata, destination_iata) WHERE
--      status='published' — enforces "no two published pages for one pair" while
--      still allowing a dead/draft historical row for the same pair.
--
-- PRECONDITION (must both hold at apply time — re-run the checks in the runbook):
--   • every source_slug in route_redirects has a published target, AND
--   • after the delete, the published-pair duplicate count is 0.
--
-- Rollback:
--   DROP INDEX IF EXISTS uq_route_pages_published_pair;
--   -- (the deleted loser rows are intentionally not restored; their URLs keep
--   --  301-ing via route_redirects. Restore from backup only if truly needed.)
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- 1) Remove duplicate losers that are safely covered by a persistent redirect.
DELETE FROM route_pages rp
USING route_redirects rr
WHERE rp.slug = rr.source_slug
  AND EXISTS (
    SELECT 1 FROM route_pages w
    WHERE w.slug = rr.target_slug AND w.status = 'published'
  );

-- 2) Fail loudly if any published-pair duplicate remains (constraint would fail
--    anyway; this makes the reason explicit in the migration).
DO $$
DECLARE dups int;
BEGIN
  SELECT count(*) INTO dups FROM (
    SELECT origin_iata, destination_iata
    FROM route_pages WHERE status='published'
    GROUP BY 1,2 HAVING count(*) > 1
  ) d;
  IF dups > 0 THEN
    RAISE EXCEPTION 'P1-1 abort: % published-pair duplicates remain — resolve before adding the unique index', dups;
  END IF;
END $$;

-- 3) Enforce uniqueness for published pairs only.
CREATE UNIQUE INDEX IF NOT EXISTS uq_route_pages_published_pair
  ON route_pages (origin_iata, destination_iata)
  WHERE status = 'published';

COMMIT;
