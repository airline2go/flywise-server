// ═══════════════════════════════════════════════════════════════════════
// src/routes/sitemap.routes.js
// ─────────────────────────────────────────────────────────────────────────
// Dedicated, PAGINATED sitemap-data endpoints — the scalable feed the frontend
// XML sitemap generator consumes so it can list EVERY indexable page, with no
// upper bound.
//
// Why this exists separately from the /route-pages, /cities, … list endpoints:
// those return at most PostgREST's default 1000 rows and carry extra payload
// (translations, intelligence columns) the sitemap doesn't need. A site with
// hundreds of thousands of route pages would silently truncate its sitemap at
// 1000×languages. These endpoints instead:
//   • page explicitly with .range(), so the frontend walks page=0,1,2,… until
//     hasMore is false and gets the COMPLETE set regardless of size;
//   • return only { id, lastmod } (routes also carry their two IATA codes so
//     the frontend can derive the airport sitemap from the full route set);
//   • filter to indexable rows using the shared indexability rules (the single
//     source of truth), so noindex/thin pages never enter the sitemap.
//
// Ordering is stable (by the id column / slug) so paging is consistent across
// requests within an ISR window.
// ═══════════════════════════════════════════════════════════════════════
const supa = require('../clients/supabase');
const rateLimit = require('../middleware/rateLimit');
const {
  routeIndexable, cityIndexable, countryIndexable, airlineIndexable,
  cityDestinationCount, countryConnectivityScore,
} = require('../services/indexability');
const { getIndexabilityData } = require('../services/indexabilityData');

const PAGE_SIZE = 1000; // one PostgREST page; the frontend concatenates pages

// First present date → 'YYYY-MM-DD', else null (an unknown date omits <lastmod>
// rather than faking "today" — same rule as the frontend serializer).
function resolveLastmod(...values) {
  for (const v of values) {
    if (!v) continue;
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

function pageParam(req) {
  const p = parseInt(req.query.page, 10);
  return Number.isFinite(p) && p >= 0 ? p : 0;
}

// Shared shape: { ok, page, hasMore, items }. hasMore is based on the RAW row
// count (pre-indexable-filter), so the frontend keeps paging until the table is
// exhausted even when a page filters down to few/zero indexable items.
function respond(res, page, rawCount, items) {
  res.json({ ok: true, page, hasMore: rawCount === PAGE_SIZE, items });
}

module.exports = (app) => {
  const limit = rateLimit('content', 2500, 60000);
  const range = (p) => [p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE - 1];

  // ─── routes ─── id = slug; also expose the two IATA codes so the frontend
  // derives the airport sitemap from the same complete route set.
  app.get('/sitemap-data/routes', limit, async (req, res) => {
    try {
      if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
      const page = pageParam(req);
      const [from, to] = range(page);
      const { data, error } = await supa.from('route_pages')
        .select('slug,updated_at,insights_updated_at,created_at,distance_km,avg_duration_min,airline_count,stop_distribution,price_sample_count,itinerary_count,intro_text,custom_faq,origin_iata,destination_iata')
        .eq('status', 'published')
        .order('slug', { ascending: true })
        .range(from, to);
      if (error) throw new Error(error.message);
      const rows = data || [];
      const items = rows.filter(routeIndexable).map((r) => ({
        id: r.slug,
        lastmod: resolveLastmod(r.updated_at, r.insights_updated_at, r.created_at),
        o: r.origin_iata,
        d: r.destination_iata,
      }));
      respond(res, page, rows.length, items);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── cities ─── indexable via the shared route-connectivity scan.
  app.get('/sitemap-data/cities', limit, async (req, res) => {
    try {
      if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
      const page = pageParam(req);
      const [from, to] = range(page);
      const { data, error } = await supa.from('cities')
        .select('city_slug,created_at,intro_text')
        .eq('status', 'published')
        .order('city_slug', { ascending: true })
        .range(from, to);
      if (error) throw new Error(error.message);
      const rows = data || [];
      const { connectivity } = await getIndexabilityData();
      const items = rows
        .filter((c) => cityIndexable(c, cityDestinationCount(connectivity, c.city_slug)))
        .map((c) => ({ id: c.city_slug, lastmod: resolveLastmod(c.created_at) }));
      respond(res, page, rows.length, items);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── countries ─── id = code.
  app.get('/sitemap-data/countries', limit, async (req, res) => {
    try {
      if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
      const page = pageParam(req);
      const [from, to] = range(page);
      const { data, error } = await supa.from('countries')
        .select('code,created_at,intro_text')
        .eq('status', 'published')
        .order('code', { ascending: true })
        .range(from, to);
      if (error) throw new Error(error.message);
      const rows = data || [];
      const { connectivity } = await getIndexabilityData();
      const items = rows
        .filter((c) => countryIndexable(c, countryConnectivityScore(connectivity, c.code)))
        .map((c) => ({ id: c.code, lastmod: resolveLastmod(c.created_at) }));
      respond(res, page, rows.length, items);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── airlines ─── id = iata_code; indexable via published-route counts.
  app.get('/sitemap-data/airlines', limit, async (req, res) => {
    try {
      if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
      const page = pageParam(req);
      const [from, to] = range(page);
      const { data, error } = await supa.from('airlines')
        .select('id,iata_code,created_at,intro_text')
        .eq('status', 'published')
        .order('iata_code', { ascending: true })
        .range(from, to);
      if (error) throw new Error(error.message);
      const rows = data || [];
      const { airlineCounts } = await getIndexabilityData();
      const items = rows
        .filter((a) => airlineIndexable(a, airlineCounts.get(a.id) || 0))
        .map((a) => ({ id: a.iata_code, lastmod: resolveLastmod(a.created_at) }));
      respond(res, page, rows.length, items);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── blog ─── per-language (each language has its own slugs). Published blog
  // posts are hand-written articles — never thin — so no indexable gate.
  app.get('/sitemap-data/blog', limit, async (req, res) => {
    try {
      if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
      const page = pageParam(req);
      const [from, to] = range(page);
      const lang = req.query.lang;
      let rows;
      if (lang && lang !== 'de') {
        // Translated slugs live in blog_post_translations, gated on the parent
        // being published.
        const { data: parents, error: pErr } = await supa.from('blog_posts')
          .select('id,updated_at,published_at').eq('status', 'published');
        if (pErr) throw new Error(pErr.message);
        const parentById = new Map((parents || []).map((p) => [p.id, p]));
        const { data, error } = await supa.from('blog_post_translations')
          .select('slug,post_id,updated_at')
          .eq('language', lang)
          .in('post_id', [...parentById.keys()].length ? [...parentById.keys()] : ['__none__'])
          .order('slug', { ascending: true })
          .range(from, to);
        if (error) throw new Error(error.message);
        rows = (data || []).map((t) => {
          const parent = parentById.get(t.post_id) || {};
          return { slug: t.slug, updated_at: t.updated_at || parent.updated_at, published_at: parent.published_at };
        });
      } else {
        const { data, error } = await supa.from('blog_posts')
          .select('slug,updated_at,published_at')
          .eq('status', 'published')
          .order('slug', { ascending: true })
          .range(from, to);
        if (error) throw new Error(error.message);
        rows = data || [];
      }
      const items = rows.map((p) => ({ id: p.slug, lastmod: resolveLastmod(p.updated_at, p.published_at) }));
      respond(res, page, rows.length, items);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
};
