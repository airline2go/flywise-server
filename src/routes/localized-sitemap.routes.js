const supa = require('../clients/supabase');
const rateLimit = require('../middleware/rateLimit');
const { isSupportedRouteSeoLocale } = require('../services/seo/routeLocales');
const PAGE_SIZE = 200;

function lastmod(...values) {
  let latestMs = -Infinity;
  for (const v of values) {
    if (!v) continue;
    const d = new Date(v);
    const ms = d.getTime();
    if (!Number.isNaN(ms) && ms > latestMs) latestMs = ms;
  }
  return latestMs === -Infinity ? null : new Date(latestMs).toISOString().slice(0, 10);
}

function parseSlugs(raw) {
  if (raw == null || raw === '') return null;
  const values = String(raw)
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const unique = [...new Set(values)];
  if (!unique.length) return null;
  if (unique.length > 100) return { error: 'slugs limit exceeded' };
  if (unique.some((slug) => !/^[a-z0-9][a-z0-9-]*$/.test(slug))) return { error: 'invalid slug' };
  return unique;
}

module.exports = (app) => app.get('/sitemap-data/routes-localized', rateLimit('content', 2500, 60000), async (req, res) => {
  try {
    const language = String(req.query.lang || '').toLowerCase();
    if (!isSupportedRouteSeoLocale(language) || language === 'de') {
      return res.status(400).json({ ok: false, error: 'unsupported localized route language' });
    }

    const rawPage = String(req.query.page == null ? '0' : req.query.page);
    if (!/^\d+$/.test(rawPage)) return res.status(400).json({ ok: false, error: 'page must be a non-negative integer' });
    const page = Number(rawPage);
    if (!Number.isSafeInteger(page)) return res.status(400).json({ ok: false, error: 'page out of range' });

    const slugs = parseSlugs(req.query.slugs);
    if (slugs?.error) return res.status(400).json({ ok: false, error: slugs.error });

    // Normal sitemap discovery can page through the full locale catalogue.
    // Recovery/authority callers can instead provide a bounded slug set so we
    // do not fetch thousands of localized rows merely to discard almost all of
    // them against a small canonical recovery cohort.
    let routeIds = null;
    if (slugs) {
      const routeQuery = await supa.from('route_pages')
        .select('id,slug,status')
        .in('slug', slugs)
        .eq('status', 'published');
      if (routeQuery.error) throw new Error(routeQuery.error.message);
      const bySlug = new Map((routeQuery.data || []).map((route) => [String(route.slug).toLowerCase(), route]));
      routeIds = slugs.map((slug) => bySlug.get(slug)?.id).filter(Boolean);
      if (!routeIds.length) return res.json({ ok: true, page: 0, hasMore: false, language, items: [] });
    }

    let localeQuery = supa.from('route_seo_locales')
      .select('route_page_id,language,seo_generated_at,updated_at')
      .eq('language', language)
      .not('seo_generated_at', 'is', null)
      .order('route_page_id', { ascending: true });

    if (routeIds) localeQuery = localeQuery.in('route_page_id', routeIds);
    else localeQuery = localeQuery.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

    const { data, error } = await localeQuery;
    if (error) throw new Error(error.message);

    const rows = data || [];
    const ids = [...new Set(rows.map((r) => r.route_page_id).filter(Boolean))];
    let routes = [];
    if (ids.length) {
      const q = await supa.from('route_pages')
        .select('id,slug,status,updated_at,insights_updated_at,created_at')
        .in('id', ids)
        .eq('status', 'published');
      if (q.error) throw new Error(q.error.message);
      routes = q.data || [];
    }

    const byId = new Map(routes.map((r) => [r.id, r]));
    const items = rows.map((r) => {
      const route = byId.get(r.route_page_id);
      if (!route) return null;
      return {
        id: route.slug,
        language,
        lastmod: lastmod(r.updated_at, r.seo_generated_at, route.updated_at, route.insights_updated_at, route.created_at),
      };
    }).filter(Boolean);

    res.json({ ok: true, page: slugs ? 0 : page, hasMore: slugs ? false : rows.length === PAGE_SIZE, language, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
