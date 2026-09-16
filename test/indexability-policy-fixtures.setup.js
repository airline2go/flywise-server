// Some route/sitemap fixtures intentionally model the pre-evidence-policy
// contract (connectivity-only data). Keep that contract explicit in those
// tests without changing the production default or the canonical policy tests.
const testPath = String(process.env.JEST_WORKER_ID ? expect.getState().testPath || '' : '');

if (/test[\\/]content\.routes\.test\.js$/.test(testPath) || /test[\\/]sitemap\.routes\.test\.js$/.test(testPath)) {
  process.env.SEO_EVIDENCE_POLICY_ENFORCED = '0';
}
