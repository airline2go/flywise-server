-- ═══════════════════════════════════════════════════════════════════════
-- seo_p0_3_health_check_streak.sql  (P0-3)
-- ─────────────────────────────────────────────────────────────────────────
-- Makes route health-checking safe against false negatives. A route must no
-- longer be flagged `dead` from a SINGLE empty date. The batch checker now:
--   • probes SEVERAL representative departure dates (catches weekly/seasonal
--     routes that don't operate on an arbitrary today+21),
--   • only counts a run as "empty" when EVERY probed date returned a clean,
--     error-free empty result (a 429/5xx/timeout/network error on any date
--     makes the run UNKNOWN, never empty — API failure is never evidence a
--     route is dead),
--   • requires the empty result to REPEAT across runs (streak) before the
--     route becomes `dead`.
--
-- Two additive, nullable-with-default columns support the streak. Purely
-- additive: no existing row's behaviour changes on apply.
--
-- Rollback:
--   ALTER TABLE route_pages DROP COLUMN IF EXISTS health_empty_streak;
--   ALTER TABLE route_pages DROP COLUMN IF EXISTS health_last_result;
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE route_pages
  ADD COLUMN IF NOT EXISTS health_empty_streak integer NOT NULL DEFAULT 0;

-- Last observed health-check outcome: 'alive' | 'empty' | 'unknown' | NULL.
ALTER TABLE route_pages
  ADD COLUMN IF NOT EXISTS health_last_result text;
