// ═══════════════════════════════════════════════════════════════
// src/routes/admin-gsc.routes.js
// [GSC-OAUTH] Google Search Console connection endpoints. All secrets stay on
// Render; the browser only ever triggers the flow and reads normalized data.
//
//   GET  /admin/seo/gsc/status      — is GSC configured / connected?
//   GET  /admin/seo/gsc/connect     — returns the Google consent URL (admin)
//   GET  /admin/seo/gsc/callback    — Google redirects here; stores the token
//   POST /admin/seo/gsc/disconnect  — forget the stored token
//   GET  /admin/seo/gsc/data        — real Pages/Queries performance rows
//
// The callback is the one endpoint WITHOUT requireAdmin (a Google browser
// redirect can't carry the admin cookie) — it is protected by the one-time
// `state` verified in gsc.handleCallback().
// ═══════════════════════════════════════════════════════════════

const rateLimit = require('../middleware/rateLimit');
const { requireAdmin } = require('../middleware/auth');
const log = require('../utils/log');
const env = require('../config/env');
const gsc = require('../services/gsc');

module.exports = (app) => {
  app.get('/admin/seo/gsc/status', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
    try {
      const conn = gsc.isConfigured() ? await gsc.getConnection() : null;
      return res.json({
        ok: true,
        configured: gsc.isConfigured(),
        connected: !!conn,
        siteUrl: gsc.siteUrl(),
        connection: conn ? { connected_at: conn.connected_at, by: conn.by || null, site_url: conn.site_url || null } : null,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/admin/seo/gsc/connect', rateLimit('admin', 30, 60000), requireAdmin, async (req, res) => {
    try {
      const authUrl = await gsc.buildAuthUrl(req.adminUserId || req.adminRole || null);
      return res.json({ ok: true, authUrl });
    } catch (e) {
      return res.status(e.status || 500).json({ ok: false, error: e.message });
    }
  });

  // Google redirects the browser here after consent. No requireAdmin (no cookie
  // on this domain) — the one-time `state` is the protection. Always ends in a
  // redirect back to the admin dashboard.
  app.get('/admin/seo/gsc/callback', async (req, res) => {
    const base = (env.ADMIN_APP_URL || 'https://airpiv.com').replace(/\/+$/, '');
    const back = (status) => res.redirect(`${base}/admin/seo-opportunities?gsc=${status}`);
    const { code, state, error } = req.query;
    if (error || !code || !state) return back('error');
    try {
      await gsc.handleCallback(String(code), String(state));
      return back('connected');
    } catch (e) {
      log('warn', 'gsc_callback_failed', { error: e.message });
      return back('error');
    }
  });

  app.post('/admin/seo/gsc/disconnect', rateLimit('admin', 30, 60000), requireAdmin, async (req, res) => {
    try {
      await gsc.disconnect();
      return res.json({ ok: true, connected: false });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/admin/seo/gsc/data', rateLimit('admin', 60, 60000), requireAdmin, async (req, res) => {
    if (!gsc.isConfigured()) return res.json({ ok: true, configured: false, connected: false, rows: [] });
    const conn = await gsc.getConnection();
    if (!conn) return res.json({ ok: true, configured: true, connected: false, rows: [] });
    const type = req.query.type === 'queries' ? 'queries' : 'pages';
    const days = parseInt(req.query.days, 10) || 28;
    try {
      const { rows, dateRange } = await gsc.fetchSearchAnalytics({ type, days });
      return res.json({ ok: true, configured: true, connected: true, type, rows, dateRange });
    } catch (e) {
      return res.status(e.status || 502).json({ ok: false, connected: true, error: e.message });
    }
  });
};
