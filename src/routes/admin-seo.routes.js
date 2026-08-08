// ═══════════════════════════════════════════════════════════════
// src/routes/admin-seo.routes.js
// [SEO-AI-OPTIMIZE] POST /admin/seo/optimize — generate a BEFORE / PROPOSED
// SEO optimization for one route using Claude. This is the trusted server layer
// that holds ANTHROPIC_API_KEY: the Vercel admin forwards the route's already-
// extracted, NON-secret page signals + GSC row here, and gets recommendations
// back. The secret key NEVER leaves Render — the browser only ever receives
// recommendations, never a key.
//
// requireAdmin (content-management tier, same as route-pages/geo/blog — not
// requireFullAdmin). Rate-limited to protect the paid AI endpoint from repeated
// clicks / parallel bursts. ADVISORY ONLY — writes nothing, applies nothing.
// ═══════════════════════════════════════════════════════════════

const rateLimit = require('../middleware/rateLimit');
const { requireAdmin } = require('../middleware/auth');
const { generateRouteOptimization } = require('../services/seoOptimizer');

module.exports = (app) => {
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

    try {
      const result = await generateRouteOptimization({ elements, gsc, dominantIntent, language });
      // Always 200 with a `source` discriminator so the caller can decide whether
      // to show the AI result or fall back to its own deterministic rules.
      return res.json({ ok: true, ...result });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
};
