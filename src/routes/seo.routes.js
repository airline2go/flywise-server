// ═══════════════════════════════════════════════════════════════
// src/routes/seo.routes.js
// /robots.txt — يمنع كل الزواحف من الزحف على نطاق الـ API
// (api.airpiv.com). الـ API بيرجّع JSON مش صفحات، فمفيش قيمة فهرسة منه.
// ═══════════════════════════════════════════════════════════════

const registerLocalizedRouteSeo = require('./localized-route-seo.routes');
const registerLocalizedSitemap = require('./localized-sitemap.routes');

module.exports = (app) => {
  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /\n');
  });

  // Registered before content.routes so localized SEO endpoints are available
  // without changing the existing route-pages contract.
  registerLocalizedRouteSeo(app);
  registerLocalizedSitemap(app);
};
