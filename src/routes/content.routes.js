// ═══════════════════════════════════════════════════════════════
// src/routes/content.routes.js
// كل محتوى SEO العام (بدون حماية أدمن): المدونة، صفحات المسارات،
// الدول، المدن، المطارات، وخريطة الموقع الديناميكية للمسارات.
// ═══════════════════════════════════════════════════════════════

const log = require('../utils/log');
const supa = require('../clients/supabase');
const rateLimit = require('../middleware/rateLimit');
const { buildRouteIntelligenceSnapshot } = require('../services/routeIntelligence');

// [RATE-LIMIT-FIX] None of these routes had any rate limiting at all —
// public, unauthenticated, and an unmetered surface for scraping/DB-
// hammering. The limit here (2500/min per IP) is deliberately generous
// rather than the tighter values used elsewhere in the API: flywise-app's
// SSG build (build/generate-pages.js) calls these same detail endpoints
// once per city/country/airport/route/blog-post from a single Render
// build-environment IP — a real site with 1000+ published routes plus
// airports/cities/countries/blog can legitimately need ~1400+ requests in
// one build run. Raised from the original 1000 after a real deploy hit it
// (build/fetch-utils.js's own concurrency+pacing was tightened at the same
// time as defense in depth — see its header comment). This still
// meaningfully throttles abusive scraping while leaving comfortable
// headroom for the build.
module.exports = (app) => {

app.get('/blog-posts', rateLimit('content', 2500, 60000), async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const lang = req.query.lang;

    // [MULTILANG-BLOG] A non-German language reads its slugs/titles from
    // blog_post_translations, joined (in app code, no PostgREST embedding) to
    // the published parent for the shared cover/author/date fields.
    if (lang && lang !== 'de') {
      const { data: parents, error: pErr } = await supa.from('blog_posts')
        .select('id,cover_image_url,author,published_at')
        .eq('status', 'published')
        .order('published_at', { ascending: false })
        .limit(limit);
      if (pErr) throw new Error(pErr.message);
      const ids = (parents || []).map((p) => p.id);
      if (!ids.length) return res.json({ ok: true, posts: [] });
      const { data: trs, error: tErr } = await supa.from('blog_post_translations')
        .select('post_id,slug,title,excerpt').eq('language', lang).in('post_id', ids);
      if (tErr) throw new Error(tErr.message);
      const byId = new Map((trs || []).map((t) => [t.post_id, t]));
      const posts = (parents || [])
        .filter((p) => byId.has(p.id))
        .map((p) => {
          const t = byId.get(p.id);
          return { slug: t.slug, title: t.title, excerpt: t.excerpt, cover_image_url: p.cover_image_url, author: p.author, published_at: p.published_at };
        });
      return res.json({ ok: true, posts });
    }

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
app.get('/blog-posts/:slug', rateLimit('content', 2500, 60000), async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const lang = req.query.lang;

    // [MULTILANG-BLOG] Non-German: look the post up by its per-language slug in
    // blog_post_translations, then confirm the parent is published.
    if (lang && lang !== 'de') {
      const { data: tr, error: trErr } = await supa.from('blog_post_translations')
        .select('slug,title,meta_description,excerpt,content,post_id')
        .eq('language', lang).eq('slug', req.params.slug).maybeSingle();
      if (trErr) throw new Error(trErr.message);
      if (!tr) return res.status(404).json({ ok: false, error: 'Beitrag nicht gefunden' });
      const { data: parent, error: pErr } = await supa.from('blog_posts')
        .select('id,cover_image_url,author,published_at,status,views_count').eq('id', tr.post_id).maybeSingle();
      if (pErr) throw new Error(pErr.message);
      if (!parent || parent.status !== 'published') return res.status(404).json({ ok: false, error: 'Beitrag nicht gefunden' });
      supa.from('blog_posts').update({ views_count: (parent.views_count || 0) + 1 }).eq('id', parent.id)
        .then(({ error: e }) => { if (e) log('warn', 'blog_view_count_failed', { error: e.message }); });
      return res.json({ ok: true, post: {
        slug: tr.slug, title: tr.title, meta_description: tr.meta_description, excerpt: tr.excerpt,
        content: tr.content, cover_image_url: parent.cover_image_url, author: parent.author, published_at: parent.published_at,
      } });
    }

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
app.get('/blog-posts-en', rateLimit('content', 2500, 60000), async (req, res) => {
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
app.get('/blog-posts-en/:slug', rateLimit('content', 2500, 60000), async (req, res) => {
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

// ─── GET /route-pages/:slug/related ────────────────────────────
// [RELATED-ROUTES] Other published routes sharing the same origin OR
// destination city — powers the "Ähnliche Flugrouten" internal-linking
// section. Excludes the route itself; capped at 6 (per spec: 3-6 related
// routes shown).
app.get('/route-pages/:slug/related', rateLimit('content', 2500, 60000), async (req, res) => {
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

app.get('/route-pages', rateLimit('content', 2500, 60000), async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    // [ROUTE-INTELLIGENCE-3] distance_km/haul_type/airline_count/route_score
    // added so the SSG build's computeRelatedRoutes() can rank alternatives
    // instead of only pure same-city matching — see generate-pages.js.
    const { data, error } = await supa.from('route_pages')
      .select('slug,origin_iata,destination_iata,origin_city,destination_city,origin_country,destination_country,distance_km,haul_type,airline_count,route_score')
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
app.get('/countries', rateLimit('content', 2500, 60000), async (req, res) => {
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
app.get('/countries/:code', rateLimit('content', 2500, 60000), async (req, res) => {
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
app.get('/cities', rateLimit('content', 2500, 60000), async (req, res) => {
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
app.get('/cities/:slug', rateLimit('content', 2500, 60000), async (req, res) => {
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
app.get('/airports', rateLimit('content', 2500, 60000), async (req, res) => {
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
app.get('/airports/:code', rateLimit('content', 2500, 60000), async (req, res) => {
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
        // [ROUTE-INTELLIGENCE-3] Optional, admin-authored — null unless
        // an admin has filled them in via the Geo CMS.
        distance_to_city_center_km: airportRow.distance_to_city_center_km,
        transit_options: airportRow.transit_options,
        terminal_info: airportRow.terminal_info,
        traveler_tips: airportRow.traveler_tips,
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

// ─── GET /airlines ────────────────────────────────────────────────
// [AIRLINE-PAGES] Public list of published airlines — same shape as
// GET /cities / GET /countries / GET /airports. Rows only exist once
// ensureAirlineExists() has observed that carrier operating at least one
// live-searched route (see search.routes.js's fetchAndCacheRoutePrice()).
app.get('/airlines', rateLimit('content', 2500, 60000), async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data, error } = await supa.from('airlines').select('iata_code,name').eq('status', 'published').order('name', { ascending: true });
    if (error) throw new Error(error.message);
    res.json({ ok: true, airlines: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /airlines/:code ───────────────────────────────────────────
// [AIRLINE-PAGES] Detail + every published route_pages entry this
// airline has been observed operating (via the route_airlines join
// table) — 404s if the airline exists but has no matching published
// route, same no-thin-content guarantee as cities/countries/airports.
app.get('/airlines/:code', rateLimit('content', 2500, 60000), async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const code = req.params.code.toUpperCase();
    const { data: airline, error: airlineErr } = await supa.from('airlines').select('*').eq('iata_code', code).eq('status', 'published').maybeSingle();
    if (airlineErr) throw new Error(airlineErr.message);
    if (!airline) return res.status(404).json({ ok: false, error: 'Airline nicht gefunden' });

    const { data: observed, error: obsErr } = await supa.from('route_airlines')
      .select('route_origin_iata,route_destination_iata,last_seen_at')
      .eq('airline_id', airline.id);
    if (obsErr) throw new Error(obsErr.message);
    if (!observed || !observed.length) return res.status(404).json({ ok: false, error: 'Keine Routen für diese Airline gefunden' });

    const pairs = observed.map((o) => `and(origin_iata.eq.${o.route_origin_iata},destination_iata.eq.${o.route_destination_iata})`);
    // [OR-BATCH] A major airline (e.g. LH/BA) is observed on hundreds of
    // routes; a single .or() with that many conditions overruns PostgREST's
    // request-length limit and comes back as "Bad Request" (surfaced to the
    // client as a 500). Query the pairs in chunks and merge — the result set
    // is identical, just assembled from several smaller requests. Dedupe by
    // slug and re-apply the origin_city ordering the single query used to do.
    const OR_CHUNK = 50;
    const routesBySlug = new Map();
    for (let i = 0; i < pairs.length; i += OR_CHUNK) {
      const { data: part, error: routesErr } = await supa.from('route_pages')
        .select('slug,origin_iata,destination_iata,origin_city,destination_city,origin_city_slug,destination_city_slug,origin_country,destination_country')
        .eq('status', 'published')
        .or(pairs.slice(i, i + OR_CHUNK).join(','));
      if (routesErr) throw new Error(routesErr.message);
      (part || []).forEach((r) => routesBySlug.set(r.slug, r));
    }
    const routes = [...routesBySlug.values()].sort((a, b) => (a.origin_city || '').localeCompare(b.origin_city || ''));
    if (!routes.length) return res.status(404).json({ ok: false, error: 'Keine Routen für diese Airline gefunden' });

    // [ROUTE-INTELLIGENCE-3] mostUsedRoutes: no per-route observation
    // frequency is tracked, so recency (last_seen_at) is the best proxy
    // available — the routes this airline has been most recently seen
    // operating, capped at 6. hubAirport: an admin-set override
    // (airlines.hub_iata) always wins; otherwise inferred as the IATA
    // code appearing most often as origin or destination across every
    // route this airline has ever been observed on.
    const routeBySlug = new Map(routes.map((r) => [`${r.origin_iata}-${r.destination_iata}`, r]));
    const mostUsedRoutes = observed
      .slice()
      .sort((a, b) => new Date(b.last_seen_at) - new Date(a.last_seen_at))
      .map((o) => routeBySlug.get(`${o.route_origin_iata}-${o.route_destination_iata}`))
      .filter(Boolean)
      .slice(0, 6);

    let hubAirport = airline.hub_iata || null;
    if (!hubAirport) {
      const airportCounts = new Map();
      observed.forEach((o) => {
        airportCounts.set(o.route_origin_iata, (airportCounts.get(o.route_origin_iata) || 0) + 1);
        airportCounts.set(o.route_destination_iata, (airportCounts.get(o.route_destination_iata) || 0) + 1);
      });
      let topCount = 0;
      for (const [code, count] of airportCounts) {
        if (count > topCount) { hubAirport = code; topCount = count; }
      }
    }

    res.json({ ok: true, airline: Object.assign({}, airline, { hubAirport }), routes, mostUsedRoutes });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /route-pages/:slug ──────────────────────────────────────
app.get('/route-pages/:slug', rateLimit('content', 2500, 60000), async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data, error } = await supa.from('route_pages').select('*').eq('slug', req.params.slug).eq('status', 'published').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ ok: false, error: 'Route nicht gefunden' });

    // [AIRLINE-SECTION] Attach the real published airlines observed operating
    // this exact route (route_airlines -> airlines), so the SSG build can
    // render an "airlines flying this route" section that links to each
    // airline's own page — durable internal linking + unique per-route
    // content, from the same accumulating table airline pages already use.
    // Fire-safe: any failure here just yields an empty list, never a 500 on
    // the route page itself.
    let airlines = [];
    try {
      const { data: raRows } = await supa.from('route_airlines')
        .select('airline_id')
        .eq('route_origin_iata', data.origin_iata)
        .eq('route_destination_iata', data.destination_iata);
      const ids = (raRows || []).map((r) => r.airline_id).filter(Boolean);
      if (ids.length) {
        const { data: alRows } = await supa.from('airlines')
          .select('iata_code,name').in('id', ids).eq('status', 'published');
        airlines = (alRows || []).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      }
    } catch (e) {
      log('warn', 'route_airlines_attach_failed', { slug: req.params.slug, error: e.message });
    }

    res.json({ ok: true, route: Object.assign({}, data, { airlines, intelligence: buildRouteIntelligenceSnapshot(data) }) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
};
