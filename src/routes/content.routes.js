// ═══════════════════════════════════════════════════════════════
// src/routes/content.routes.js
// كل محتوى SEO العام (بدون حماية أدمن): المدونة، صفحات المسارات،
// الدول، المدن، المطارات، وخريطة الموقع الديناميكية للمسارات.
// ═══════════════════════════════════════════════════════════════

const log = require('../utils/log');
const supa = require('../clients/supabase');
const rateLimit = require('../middleware/rateLimit');

// [RATE-LIMIT-FIX] None of these routes had any rate limiting at all —
// public, unauthenticated, and an unmetered surface for scraping/DB-
// hammering. The limit here (1000/min per IP) is deliberately generous
// rather than the tighter values used elsewhere in the API: flywise-app's
// SSG build (build/generate-pages.js) calls these same detail endpoints
// once per city/country/airport/route/blog-post from a single Render
// build-environment IP, with 8-way bounded concurrency — a real site with
// hundreds of published routes can legitimately produce a burst well
// above a "normal visitor" rate limit. This still meaningfully throttles
// abusive scraping while leaving comfortable headroom for the build.
module.exports = (app) => {

app.get('/blog-posts', rateLimit('content', 1000, 60000), async (req, res) => {
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
app.get('/blog-posts/:slug', rateLimit('content', 1000, 60000), async (req, res) => {
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

// ─── GET /blog-posts-en ─────────────────────────────────────────
// [EN-BLOG] English list — same blog_posts table, filtered to rows that
// have an English translation (slug_en set) and are published. Mirrors
// GET /blog-posts, aliased to the same field names so the public
// /en/blog listing page and the SSG build's blog-posts-en fetch need no
// language-specific handling.
app.get('/blog-posts-en', rateLimit('content', 1000, 60000), async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const { data, error } = await supa.from('blog_posts')
      .select('slug:slug_en,title:title_en,excerpt:meta_description_en,cover_image_url,author,published_at')
      .eq('status', 'published')
      .not('slug_en', 'is', null)
      .order('published_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    res.json({ ok: true, posts: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /blog-posts-en/:slug ───────────────────────────────────
// [EN-BLOG] Single published post by its English slug, looked up on the
// same row as the German post. Mirrors GET /blog-posts/:slug (same
// view-count bump), remapped onto the shared slug/title/content/excerpt
// field names the public post-detail page and the SSG build expect.
app.get('/blog-posts-en/:slug', rateLimit('content', 1000, 60000), async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data, error } = await supa.from('blog_posts').select('*').eq('slug_en', req.params.slug).eq('status', 'published').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ ok: false, error: 'Beitrag nicht gefunden' });
    supa.from('blog_posts').update({ views_count: (data.views_count || 0) + 1 }).eq('id', data.id)
      .then(({ error: e }) => { if (e) log('warn', 'blog_view_count_failed', { error: e.message }); });
    const post = Object.assign({}, data, {
      slug: data.slug_en,
      title: data.title_en,
      content: data.content_en,
      excerpt: data.meta_description_en || data.excerpt,
      meta_description: data.meta_description_en,
    });
    res.json({ ok: true, post });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/sitemap-routes.xml', rateLimit('content', 1000, 60000), async (req, res) => {
  try {
    if (!supa) return res.status(503).send('');
    const { data, error } = await supa.from('route_pages')
      .select('slug, updated_at')
      .eq('status', 'published');
    if (error) throw new Error(error.message);

    const urls = (data || []).map((r) => {
      const lastmod = new Date(r.updated_at || Date.now()).toISOString().slice(0, 10);
      return `  <url>\n    <loc>https://airpiv.com/flights/${encodeURIComponent(r.slug)}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.7</priority>\n  </url>`;
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
app.get('/route-pages/:slug/related', rateLimit('content', 1000, 60000), async (req, res) => {
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

app.get('/route-pages', rateLimit('content', 1000, 60000), async (req, res) => {
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
app.get('/countries', rateLimit('content', 1000, 60000), async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data, error } = await supa.from('countries').select('code,name').eq('status', 'published').order('name', { ascending: true });
    if (error) throw new Error(error.message);
    const countries = data || [];

    // [GEO-CMS] One bounded follow-up query for every country's
    // translations, grouped in JS — not N+1 queries. The SSG build fetches
    // this list exactly once and needs every country's translations to
    // build its global localization lookup, so it's cheaper to include
    // them here than to have the build re-fetch each country individually.
    const codes = countries.map((c) => c.code);
    let translationsByCode = {};
    if (codes.length) {
      const { data: t, error: tErr } = await supa.from('country_translations').select('country_code,language,name').in('country_code', codes);
      if (tErr) throw new Error(tErr.message);
      (t || []).forEach((r) => {
        if (!translationsByCode[r.country_code]) translationsByCode[r.country_code] = {};
        translationsByCode[r.country_code][r.language] = r.name;
      });
    }

    res.json({ ok: true, countries: countries.map((c) => ({ ...c, translations: translationsByCode[c.code] || {} })) });
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
app.get('/countries/:code', rateLimit('content', 1000, 60000), async (req, res) => {
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

    // [GEO-CMS] 7-language name translations, e.g.
    // {name:"Germany", translations:{en:"Germany", de:"Deutschland", ...}}
    // — falls back to just the legacy `name` field for any language not
    // yet translated (nothing to backfill for a brand-new country row).
    const { data: t, error: tErr } = await supa.from('country_translations').select('language,name').eq('country_code', code);
    if (tErr) throw new Error(tErr.message);
    const translations = {};
    (t || []).forEach((r) => { translations[r.language] = r.name; });

    res.json({ ok: true, country: { ...country, translations }, routes });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /cities ───────────────────────────────────────────────
// [CITY-PAGES] Public list of published cities — mirrors GET /countries
// exactly. Only cities with at least one real route actually exist here
// (see ensureCityExists), so this never returns an empty/thin entry.
app.get('/cities', rateLimit('content', 1000, 60000), async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    // [GEO-CMS] airport_codes included so the SSG build can resolve "which
    // city does this IATA code belong to" client-side (a city's name
    // translations apply to every airport serving it, e.g. LHR/LGW/STN/LTN
    // all localize to the same "London" translations).
    const { data, error } = await supa.from('cities').select('id,city_slug,name,airport_codes').eq('status', 'published').order('name', { ascending: true });
    if (error) throw new Error(error.message);
    const cities = data || [];

    // [GEO-CMS] Same bounded-follow-up-query pattern as GET /countries.
    const ids = cities.map((c) => c.id);
    let translationsById = {};
    if (ids.length) {
      const { data: t, error: tErr } = await supa.from('city_translations').select('city_id,language,name').in('city_id', ids);
      if (tErr) throw new Error(tErr.message);
      (t || []).forEach((r) => {
        if (!translationsById[r.city_id]) translationsById[r.city_id] = {};
        translationsById[r.city_id][r.language] = r.name;
      });
    }

    res.json({ ok: true, cities: cities.map((c) => ({ city_slug: c.city_slug, name: c.name, airport_codes: c.airport_codes || [], translations: translationsById[c.id] || {} })) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /cities/:slug ──────────────────────────────────────────
// [CITY-PAGES] Single city plus every published route that touches it
// (as origin OR destination) — what the public city.html page renders.
// Mirrors /countries/:code exactly. 404s if the city doesn't exist or
// has no published routes left, never serving an empty shell page.
app.get('/cities/:slug', rateLimit('content', 1000, 60000), async (req, res) => {
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

    // [GEO-CMS] 7-language name translations, same shape as /countries/:code.
    const { data: t, error: tErr } = await supa.from('city_translations').select('language,name').eq('city_id', city.id);
    if (tErr) throw new Error(tErr.message);
    const translations = {};
    (t || []).forEach((r) => { translations[r.language] = r.name; });

    res.json({ ok: true, city: { ...city, translations }, routes });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /airports ───────────────────────────────────────────────
// [AIRPORT-IDENTITY-FIRST] Public list of published, authoritative
// airport rows — mirrors GET /cities / GET /countries. Used by the
// admin Geo CMS and, going forward, by the SSG build. Airports not yet
// backfilled into this table (see the fallback in GET /airports/:code
// below) simply won't appear here until ensureAirportExists() or the
// admin Geo CMS creates a row for them.
app.get('/airports', rateLimit('content', 1000, 60000), async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data, error } = await supa.from('airports').select('iata_code,airport_name,city_id,country_code').eq('status', 'published').order('iata_code', { ascending: true });
    if (error) throw new Error(error.message);
    res.json({ ok: true, airports: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /airports/:code ─────────────────────────────────────────
// [AIRPORT-PAGES] The 4th and final level of the Home → Country → City
// → Airport hierarchy. [AIRPORT-IDENTITY-FIRST] Prefers the
// authoritative `airports` table (IATA code -> airport row -> city ->
// country) over deriving live from route_pages — but falls back to the
// old live-derivation for any code ensureAirportExists() hasn't
// backfilled yet (e.g. a route published before the Geo CMS migration
// that hasn't been re-saved since), so no existing airport page
// regresses the moment this ships. 404s if no published route touches
// this airport at all, same no-thin-content guarantee as every other
// level, regardless of whether an authoritative row exists.
app.get('/airports/:code', rateLimit('content', 1000, 60000), async (req, res) => {
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

    const firstAsOrigin = routes.find((r) => r.origin_iata === code);
    const firstAsDest = routes.find((r) => r.destination_iata === code);
    const ref = firstAsOrigin || firstAsDest;
    const fallbackCity = firstAsOrigin ? ref.origin_city : ref.destination_city;
    const fallbackCitySlug = firstAsOrigin ? ref.origin_city_slug : ref.destination_city_slug;
    const fallbackCountry = firstAsOrigin ? ref.origin_country : ref.destination_country;
    const fallbackLat = firstAsOrigin ? ref.origin_lat : ref.destination_lat;
    const fallbackLng = firstAsOrigin ? ref.origin_lng : ref.destination_lng;

    const { data: airportRow, error: airportErr } = await supa.from('airports').select('*').eq('iata_code', code).maybeSingle();
    if (airportErr) throw new Error(airportErr.message);

    let translations = {};
    let citySlug = fallbackCitySlug;
    let cityName = fallbackCity;
    let countryCode = fallbackCountry;
    let airport;

    if (airportRow) {
      const { data: t } = await supa.from('airport_translations').select('language,name').eq('airport_id', airportRow.id);
      (t || []).forEach((r) => { translations[r.language] = r.name; });
      if (airportRow.city_id) {
        const { data: c } = await supa.from('cities').select('city_slug,name').eq('id', airportRow.city_id).maybeSingle();
        if (c) { citySlug = c.city_slug; cityName = c.name; }
      }
      countryCode = airportRow.country_code || fallbackCountry;
      airport = {
        code,
        name: airportRow.airport_name,
        icao: airportRow.icao_code,
        city: cityName,
        city_slug: citySlug,
        country: countryCode,
        lat: airportRow.latitude != null ? airportRow.latitude : fallbackLat,
        lng: airportRow.longitude != null ? airportRow.longitude : fallbackLng,
        translations,
      };
    } else {
      airport = {
        code,
        name: code,
        city: fallbackCity,
        city_slug: fallbackCitySlug,
        country: fallbackCountry,
        lat: fallbackLat,
        lng: fallbackLng,
        translations,
      };
    }

    // [GEO-CMS] Also surface the linked city's/country's own translations
    // so the airport page can localize those without an extra round trip.
    let cityTranslations = {}, countryTranslations = {};
    if (citySlug) {
      const { data: cityRow } = await supa.from('cities').select('id').eq('city_slug', citySlug).maybeSingle();
      if (cityRow) {
        const { data: ct } = await supa.from('city_translations').select('language,name').eq('city_id', cityRow.id);
        (ct || []).forEach((r) => { cityTranslations[r.language] = r.name; });
      }
    }
    if (countryCode) {
      const { data: cot } = await supa.from('country_translations').select('language,name').eq('country_code', countryCode);
      (cot || []).forEach((r) => { countryTranslations[r.language] = r.name; });
    }
    airport.city_translations = cityTranslations;
    airport.country_translations = countryTranslations;

    res.json({ ok: true, airport, routes });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /route-pages/:slug ──────────────────────────────────────
app.get('/route-pages/:slug', rateLimit('content', 1000, 60000), async (req, res) => {
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
