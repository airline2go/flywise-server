const rateLimit = require('../middleware/rateLimit');
const supa = require('../clients/supabase');
const { effectiveLocalizedRouteSeo } = require('../services/seo/localizedEffective');
const { getRouteSeoLocales, isSupportedRouteSeoLocale } = require('../services/seo/multilingual');

const DEFAULT_SITE_URL = 'https://airpiv.com';

function siteUrl() {
  return String(process.env.PUBLIC_SITE_URL || process.env.SITE_URL || DEFAULT_SITE_URL)
    .replace(/\/+$/, '');
}

function localizedPath(language, slug) {
  return language === 'de' ? `/flights/${slug}` : `/${language}/flights/${slug}`;
}

async function buildRouteAlternates(routeId, slug) {
  const alternates = [{
    language: 'de',
    hrefLang: 'de',
    href: `${siteUrl()}${localizedPath('de', slug)}`,
  }];

  const { data, error } = await supa.from('route_seo_locales')
    .select('language,seo_generated_at')
    .eq('route_page_id', routeId)
    .not('seo_generated_at', 'is', null);
  if (error) throw new Error(error.message);

  for (const row of data || []) {
    if (!isSupportedRouteSeoLocale(row.language) || row.language === 'de') continue;
    alternates.push({
      language: row.language,
      hrefLang: row.language,
      href: `${siteUrl()}${localizedPath(row.language, slug)}`,
    });
  }

  // The German route is the stable fallback for users/search engines when no
  // more specific language version exists.
  alternates.push({
    language: 'x-default',
    hrefLang: 'x-default',
    href: `${siteUrl()}${localizedPath('de', slug)}`,
  });

  return alternates;
}

module.exports = (app) => {
  app.get('/route-pages/:slug/localized', rateLimit('content', 2500, 60000), async (req, res) => {
    try {
      if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
      const language = String(req.query.lang || '').toLowerCase();
      if (!isSupportedRouteSeoLocale(language) || language === 'de') {
        return res.status(400).json({ ok: false, error: 'unsupported localized route language' });
      }

      const { data: route, error: routeError } = await supa.from('route_pages')
        .select('*')
        .eq('slug', req.params.slug)
        .eq('status', 'published')
        .maybeSingle();
      if (routeError) throw new Error(routeError.message);
      if (!route) return res.status(404).json({ ok: false, error: 'Route nicht gefunden' });

      const { data: row, error: seoError } = await supa.from('route_seo_locales')
        .select('*')
        .eq('route_page_id', route.id)
        .eq('language', language)
        .not('seo_generated_at', 'is', null)
        .maybeSingle();
      if (seoError) throw new Error(seoError.message);
      if (!row) return res.status(404).json({ ok: false, error: 'Localized SEO not generated' });

      const alternates = await buildRouteAlternates(route.id, route.slug);
      res.json({
        ok: true,
        route: Object.assign({}, route, {
          language,
          seo: effectiveLocalizedRouteSeo(row),
          hreflang: alternates,
        }),
        languages: getRouteSeoLocales(),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/route-pages/:slug/hreflang', rateLimit('content', 2500, 60000), async (req, res) => {
    try {
      if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
      const { data: route, error } = await supa.from('route_pages')
        .select('id,slug,status')
        .eq('slug', req.params.slug)
        .eq('status', 'published')
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!route) return res.status(404).json({ ok: false, error: 'Route nicht gefunden' });
      res.json({ ok: true, hreflang: await buildRouteAlternates(route.id, route.slug) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
};
