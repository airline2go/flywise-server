// Tests that exercise the historical/default SEO behaviour should not inherit
// production's evidence-enforcement default. Individual enforcement tests pass
// { enforce: true } explicitly, so the test suite remains deterministic without
// weakening the production configuration.
if (process.env.NODE_ENV === 'test' && process.env.SEO_EVIDENCE_POLICY_ENFORCED === undefined) {
  process.env.SEO_EVIDENCE_POLICY_ENFORCED = 'false';
}
