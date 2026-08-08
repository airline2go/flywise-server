// ═══════════════════════════════════════════════════════════════
// src/routes/admin-seo.routes.js
// [SEO-AI-OPTIMIZE] Route SEO optimization endpoints. This is the trusted server
// layer that holds ANTHROPIC_API_KEY: the Vercel admin forwards a route's
// already-extracted, NON-secret page signals + GSC row here, and gets
// recommendations back. The secret key NEVER leaves Render.
//
//   POST  /admin/seo/optimize          — generate a BEFORE/PROPOSED suggestion
//                                         (Claude) and STORE it for audit (§16).
//   GET   /admin/seo/optimizations      — a route's stored optimization history.
//   PATCH /admin/seo/optimizations/:id  — transition review status (§17):
//                                         generated → reviewed → approved/rejected.
//
// requireAdmin (content-management tier). The optimize endpoint is rate-limited
// to protect the paid AI endpoint. ADVISORY ONLY — nothing here writes to a live
// page; applying an approved suggestion is a separate, gated step.
// ═══════════════════════════════════════════════════════════════

const rateLimit = require('../middleware/rateLimit');
const { requireAdmin } = require('../middleware/auth');
const { generateRouteOptimization } = require('../services/seoOptimizer');
const store = require('../services/seoOptimizationStore');
const { applyOptimization, rollbackOptimization } = require('../services/seoApply');
const triggerRebuild = require('../utils/triggerRebuild');

const SLUG_RE = /^[a-z0-9-]{2,80}$/i;

module.exports = (app) => {
  // ── Generate + store ───────────────────────────────────────────────────
  app.post('/admin/seo/optimize', rateLimit('admin-seo-ai', 30, 60000), requireAdmin, async (req, res) => {
    const body = req.body || {};
    const elements = body.elements;
    if (!elements || typeof elements !== 'object') {
      return res.status(400).json({ ok: false, error: 'elements (Seiten-Signale) erforderlich' });
    }
    const language = typeof body.language === 'string' && body.language
      ? body.language
      : (typeof body.lang === 'string' && body.lang ? body.lang : 'de');
    const dominantIntent = typeof body.dominantIntent === 'string' ? body.dominantIntent : null;
    const gsc = body.gsc && typeof body.gsc === 'object' ? body.gsc : null;
    const slug = typeof body.slug === 'string' && SLUG_RE.test(body.slug) ? body.slug : null;

    try {
      const result = await generateRouteOptimization({ elements, gsc, dominantIntent, language });
      // Persist a usable AI suggestion for audit/history (best-effort — a storage
      // failure never blocks returning the suggestion to the operator).
      let id = null;
      if (result.source === 'ai' && result.suggestions && slug) {
        id = await store.storeOptimization({
          slug,
          language,
          source: 'ai',
          model: result.model,
          dominantIntent,
          gsc,
          suggestions: result.suggestions,
          createdBy: req.adminUserId || req.adminRole || null,
        });
      }
      // Always 200 with a `source` discriminator so the caller can decide whether
      // to show the AI result or fall back to its own deterministic rules.
      return res.json({ ok: true, ...result, id });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── History for a route ────────────────────────────────────────────────
  app.get('/admin/seo/optimizations', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
    const slug = (req.query.slug || '').trim();
    if (!SLUG_RE.test(slug)) return res.status(400).json({ ok: false, error: 'slug erforderlich' });
    const language = typeof req.query.language === 'string' && req.query.language ? req.query.language : null;
    const limit = parseInt(req.query.limit, 10) || 20;
    const optimizations = await store.listOptimizations({ slug, language, limit });
    return res.json({ ok: true, optimizations });
  });

  // ── Review-status transition (audit) ───────────────────────────────────
  app.patch('/admin/seo/optimizations/:id', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
    const id = (req.params.id || '').trim();
    const status = req.body && req.body.status;
    try {
      const row = await store.updateOptimizationStatus({ id, status, reviewedBy: req.adminUserId || req.adminRole || null });
      return res.json({ ok: true, optimization: row });
    } catch (e) {
      return res.status(e.status || 500).json({ ok: false, error: e.message });
    }
  });

  // ── Apply an APPROVED optimization to the live route (§7/§9) ────────────
  // Writes only the four generated seo_* columns, captures the previous values
  // for rollback, then revalidates the affected route. Individual apply only —
  // there is deliberately NO "apply all".
  app.post('/admin/seo/optimizations/:id/apply', rateLimit('admin-seo-apply', 30, 60000), requireAdmin, async (req, res) => {
    const id = (req.params.id || '').trim();
    try {
      const result = await applyOptimization({ id, appliedBy: req.adminUserId || req.adminRole || null });
      // Refresh the public page so the change is visible now, not on the next ISR
      // window (fire-and-forget — never blocks or fails the apply).
      triggerRebuild([{ type: 'route', slug: result.slug }]);
      return res.json({ ok: true, optimization: result.optimization, oldValues: result.oldValues, newValues: result.newValues });
    } catch (e) {
      return res.status(e.status || 500).json({ ok: false, error: e.message });
    }
  });

  // ── Roll an APPLIED optimization back to the exact previous values (§18) ─
  app.post('/admin/seo/optimizations/:id/rollback', rateLimit('admin-seo-apply', 30, 60000), requireAdmin, async (req, res) => {
    const id = (req.params.id || '').trim();
    const reason = req.body && typeof req.body.reason === 'string' ? req.body.reason : null;
    try {
      const result = await rollbackOptimization({ id, rolledBackBy: req.adminUserId || req.adminRole || null, reason });
      triggerRebuild([{ type: 'route', slug: result.slug }]);
      return res.json({ ok: true, optimization: result.optimization });
    } catch (e) {
      return res.status(e.status || 500).json({ ok: false, error: e.message });
    }
  });
};
