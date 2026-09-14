// ═══════════════════════════════════════════════════════════════
// src/routes/seo.routes.js
// SEO-only public endpoints. Registered early so robots.txt and the
// localized route SEO/sitemap feeds remain available independently of
// the main content route registration.
// ═══════════════════════════════════════════════════════════════

const registerLocalizedRouteSeo = require('./localized-route-seo.routes');
const registerLocalizedSitemap = require('./localized-sitemap.routes');

module.exports = (app) => {
  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /\n');
  });
  registerLocalizedRouteSeo(app);
  registerLocalizedSitemap(app);
};
