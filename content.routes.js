// ═══════════════════════════════════════════════════════════════
// src/routes/content.routes.js
// كل محتوى SEO العام (بدون حماية أدمن): المدونة، صفحات المسارات،
// الدول، المدن، المطارات، وخريطة الموقع الديناميكية للمسارات.
// ═══════════════════════════════════════════════════════════════

const log = require('./log');
const supa = require('./supabase');

module.exports = (app) => {

app.get('/blog-posts', async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const { data, error } = await supa.from('blog_posts')
      .select('slug,title,excerpt,cover_image_url,author,published_at')
      .eq('status', 'published')
      .order('published_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    res.json({ ok: true, posts: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /blog-posts/:slug ──────────────────────────────────────
// Single published post by slug, for the public post-detail page.
// Increments views_count best-effort (fire-and-forget — a failed view
// count update must never block the post from rendering for the reader).
app.get('/blog-posts/:slug', async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data, error } = await supa.from('blog_posts').select('*').eq('slug', req.params.slug).eq('status', 'published').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ ok: false, error: 'Beitrag nicht gefunden' });
    supa.from('blog_posts').update({ views_count: (data.views_count || 0) + 1 }).eq('id', data.id)
      .then(({ error: e }) => { if (e) log('warn', 'blog_view_count_failed', { error: e.message }); });
    res.json({ ok: true, post: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/sitemap-routes.xml', async (req, res) => {
  try {
    if (!supa) return res.status(503).send('');
    const { data, error } = await supa.from('route_pages')
      .select('slug, updated_at')
      .eq('status', 'published');
    if (error) throw new Error(error.message);

    const urls = (data || []).map((r) => {
      const lastmod = new Date(r.updated_at || Date.now()).toISOString().slice(0, 10);
      return `  <url>\n    <loc>https://airpiv.com/flight-route.html?slug=${encodeURIComponent(r.slug)}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.7</priority>\n  </url>`;
    }).join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
    res.set('Content-Type', 'application/xml');
    res.set('Cache-Control', 'public, max-age=3600'); // ساعة كاش — كافية، المسارات لا تتغير كل دقيقة
    res.send(xml);
  } catch (err) {
    res.status(500).send('');
  }
});

// ─── GET /route-pages/:slug/related ────────────────────────────
// [RELATED-ROUTES] Other published routes sharing the same origin OR
// destination city — powers the "Ähnliche Flugrouten" internal-linking
// section. Excludes the route itself; capped at 6 (per spec: 3-6 related
// routes shown).
app.get('/route-pages/:slug/related', async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data: current, error: e1 } = await supa.from('route_pages').select('id, origin_city, destination_city').eq('slug', req.params.slug).maybeSingle();
    if (e1) throw new Error(e1.message);
    if (!current) return res.status(404).json({ ok: false, error: 'Route nicht gefunden' });

    const { data, error: e2 } = await supa.from('route_pages')
      .select('slug, origin_city, destination_city, origin_iata, destination_iata')
      .eq('status', 'published')
      .neq('id', current.id)
      .or(`origin_city.eq.${current.origin_city},destination_city.eq.${current.destination_city}`)
      .limit(6);
    if (e2) throw new Error(e2.message);
    res.json({ ok: true, related: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/route-pages', async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data, error } = await supa.from('route_pages')
      .select('slug,origin_iata,destination_iata,origin_city,destination_city,origin_country,destination_country')
      .eq('status', 'published')
      .order('origin_city', { ascending: true });
    if (error) throw new Error(error.message);
    res.json({ ok: true, routes: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /countries ───────────────────────────────────────────
// [COUNTRY-PAGES] Public list of published countries — only ones with at
// least one real route actually exist here (see ensureCountryExists),
// so this never returns an empty/thin entry.
app.get('/countries', async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data, error } = await supa.from('countries').select('code,name').eq('status', 'published').order('name', { ascending: true });
    if (error) throw new Error(error.message);
    res.json({ ok: true, countries: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /countries/:code ──────────────────────────────────────
// [COUNTRY-PAGES] Single country plus every published route that
// touches it (as origin OR destination) — what the public country.html
// page actually renders. 404s if the country doesn't exist or has no
// published routes left (e.g. the last route touching it was
// unpublished/deleted) — never serves an empty shell page.
app.get('/countries/:code', async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const code = req.params.code.toUpperCase();
    const { data: country, error: countryErr } = await supa.from('countries').select('*').eq('code', code).eq('status', 'published').maybeSingle();
    if (countryErr) throw new Error(countryErr.message);
    if (!country) return res.status(404).json({ ok: false, error: 'Land nicht gefunden' });

    const { data: routes, error: routesErr } = await supa.from('route_pages')
      .select('slug,origin_iata,destination_iata,origin_city,destination_city,origin_country,destination_country')
      .eq('status', 'published')
      .or(`origin_country.eq.${code},destination_country.eq.${code}`)
      .order('origin_city', { ascending: true });
    if (routesErr) throw new Error(routesErr.message);
    if (!routes || !routes.length) return res.status(404).json({ ok: false, error: 'Keine Routen für dieses Land gefunden' });

    res.json({ ok: true, country, routes });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /cities/:slug ──────────────────────────────────────────
// [CITY-PAGES] Single city plus every published route that touches it
// (as origin OR destination) — what the public city.html page renders.
// Mirrors /countries/:code exactly. 404s if the city doesn't exist or
// has no published routes left, never serving an empty shell page.
app.get('/cities/:slug', async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const citySlug = req.params.slug.toLowerCase();
    const { data: city, error: cityErr } = await supa.from('cities').select('*').eq('city_slug', citySlug).eq('status', 'published').maybeSingle();
    if (cityErr) throw new Error(cityErr.message);
    if (!city) return res.status(404).json({ ok: false, error: 'Stadt nicht gefunden' });

    const { data: routes, error: routesErr } = await supa.from('route_pages')
      .select('slug,origin_iata,destination_iata,origin_city,destination_city,origin_city_slug,destination_city_slug,origin_country,destination_country')
      .eq('status', 'published')
      .or(`origin_city_slug.eq.${citySlug},destination_city_slug.eq.${citySlug}`)
      .order('origin_city', { ascending: true });
    if (routesErr) throw new Error(routesErr.message);
    if (!routes || !routes.length) return res.status(404).json({ ok: false, error: 'Keine Routen für diese Stadt gefunden' });

    res.json({ ok: true, city, routes });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /airports/:code ─────────────────────────────────────────
// [AIRPORT-PAGES] The 4th and final level of the Home → Country → City
// → Airport hierarchy. Unlike countries/cities, airports need no
// separate table or auto-creation step — every route_pages row already
// carries the airport's IATA code, city, and coordinates directly, so
// an airport page simply exists whenever at least one published route
// uses that code. 404s if no published route touches this airport at
// all, same no-thin-content guarantee as every other level.
app.get('/airports/:code', async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const code = req.params.code.toUpperCase();
    const { data: routes, error: routesErr } = await supa.from('route_pages')
      .select('slug,origin_iata,destination_iata,origin_city,destination_city,origin_city_slug,destination_city_slug,origin_country,destination_country,origin_lat,origin_lng,destination_lat,destination_lng')
      .eq('status', 'published')
      .or(`origin_iata.eq.${code},destination_iata.eq.${code}`)
      .order('origin_city', { ascending: true });
    if (routesErr) throw new Error(routesErr.message);
    if (!routes || !routes.length) return res.status(404).json({ ok: false, error: 'Flughafen nicht gefunden' });

    // [AIRPORT-PAGES] Derive the airport's display city/country/slug/
    // coordinates from whichever route mentions it first — there's no
    // separate airports table holding this independently, so this is
    // the only source of truth available.
    const firstAsOrigin = routes.find((r) => r.origin_iata === code);
    const firstAsDest = routes.find((r) => r.destination_iata === code);
    const ref = firstAsOrigin || firstAsDest;
    const airport = {
      code,
      city: firstAsOrigin ? ref.origin_city : ref.destination_city,
      city_slug: firstAsOrigin ? ref.origin_city_slug : ref.destination_city_slug,
      country: firstAsOrigin ? ref.origin_country : ref.destination_country,
      lat: firstAsOrigin ? ref.origin_lat : ref.destination_lat,
      lng: firstAsOrigin ? ref.origin_lng : ref.destination_lng,
    };

    res.json({ ok: true, airport, routes });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /route-pages/:slug ──────────────────────────────────────
app.get('/route-pages/:slug', async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data, error } = await supa.from('route_pages').select('*').eq('slug', req.params.slug).eq('status', 'published').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ ok: false, error: 'Route nicht gefunden' });
    res.json({ ok: true, route: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
};
