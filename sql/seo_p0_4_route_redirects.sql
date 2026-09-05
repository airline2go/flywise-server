-- ═══════════════════════════════════════════════════════════════════════
-- seo_p0_4_route_redirects.sql  (P0-4)
-- ─────────────────────────────────────────────────────────────────────────
-- PERSISTENT redirect storage so a consolidated-duplicate 301 SURVIVES the
-- deletion of its loser route_pages row. Previously the loser→winner redirect
-- was derived live from the published route list (buildCanonicalSlugMap); if
-- the loser row were ever deleted the redirect vanished and the old (already
-- Google-discovered) URL started 404-ing. This table makes the redirect a
-- first-class, durable fact the route handler consults BEFORE route lookup.
--
-- Rules enforced here:
--   • source_slug UNIQUE          — one destination per old URL
--   • source_slug <> target_slug  — no self-redirect
--   • single hop is a data invariant: a target_slug must never also appear as a
--     source_slug (enforced by the backfill/insert path, which collapses chains
--     to the final target before writing).
--
-- Rollback:  DROP TABLE IF EXISTS route_redirects;
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS route_redirects (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_slug  text NOT NULL UNIQUE,
  target_slug  text NOT NULL,
  status_code  integer NOT NULL DEFAULT 301,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT route_redirects_no_self CHECK (source_slug <> target_slug),
  CONSTRAINT route_redirects_status CHECK (status_code IN (301, 302, 308))
);

CREATE INDEX IF NOT EXISTS idx_route_redirects_source ON route_redirects (source_slug);

-- Public read (parity with the published content this drives); writes are
-- service-role only (no anon/authenticated write policy is created).
ALTER TABLE route_redirects ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='route_redirects' AND policyname='route_redirects_public_read'
  ) THEN
    CREATE POLICY route_redirects_public_read ON route_redirects FOR SELECT USING (true);
  END IF;
END $$;
