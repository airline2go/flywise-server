// ═══════════════════════════════════════════════════════════════
// src/routes/admin-geo.routes.js
// [GEO-CMS] Airport-Identity-First Geo CMS — CRUD for cities,
// countries, airports, and their 7-language translations, all
// requireAdmin (content management, same tier as route-pages/blog —
// not requireFullAdmin, which stays reserved for margins/credit/staff).
// Mirrors GET /admin/route-pages' list/paginate/search/filter shape
// exactly, and the same auto-population tables ensureCityExists()/
// ensureCountryExists()/ensureAirportExists() already keep in sync.
// ═══════════════════════════════════════════════════════════════

const log = require('../utils/log');
const supa = require('../clients/supabase');
const rateLimit = require('../middleware/rateLimit');
const { requireAdmin } = require('../middleware/auth');

const LANGUAGES = ['en', 'de', 'ar', 'es', 'fr', 'it', 'nl'];

// [TRANSLATION-COUNT] Bounded follow-up query (never a raw table scan) —
// fetches only the language column for the current page's rows, then
// counts in Node, same "bounded fetch, aggregate in JS" pattern already
// used by GET /admin/stats and the API-monitoring dashboard.
async function attachTranslationCounts(table, idColumn, rows, idKey) {
  const ids = rows.map((r) => r[idKey]).filter(Boolean);
  if (!ids.length) return rows;
  const { data, error } = await supa.from(table).select(idColumn).in(idColumn, ids);
  if (error) throw new Error(error.message);
  const counts = {};
  (data || []).forEach((r) => { counts[r[idColumn]] = (counts[r[idColumn]] || 0) + 1; });
  return rows.map((r) => ({ ...r, translations_count: counts[r[idKey]] || 0 }));
}

function validateTranslationsPayload(translations) {
  if (!translations || typeof translations !== 'object' || Array.isArray(translations)) {
    throw Object.assign(new Error('translations muss ein Objekt sein'), { status: 400 });
  }
  const entries = Object.entries(translations).filter(([, v]) => v != null && String(v).trim() !== '');
  for (const [lang] of entries) {
    if (!LANGUAGES.includes(lang)) {
      throw Object.assign(new Error(`Ungültige Sprache: ${lang}`), { status: 400 });
    }
  }
  return entries;
}

module.exports = (app) => {

// ─── Cities ──────────────────────────────────────────────────
app.get('/admin/cities', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const q = (req.query.q || '').trim();
    const statusFilter = req.query.status;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = supa.from('cities').select('*', { count: 'exact' });
    if (statusFilter === 'published' || statusFilter === 'draft') query = query.eq('status', statusFilter);
    if (q) {
      const esc = q.replace(/[%_]/g, '\\$&');
      query = query.or(`name.ilike.%${esc}%,city_slug.ilike.%${esc}%`);
    }
    query = query.order('name', { ascending: true }).range(from, to);

    const { data, error, count } = await query;
    if (error) throw new Error(error.message);
    const cities = await attachTranslationCounts('city_translations', 'city_id', data || [], 'id');
    res.json({ ok: true, cities, total: count || 0, page, limit, totalPages: Math.max(1, Math.ceil((count || 0) / limit)) });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/cities', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { city_slug, name, country_code, status, intro_text } = req.body || {};
    if (!city_slug || !name) return res.status(400).json({ ok: false, error: 'city_slug und name sind erforderlich' });
    const { data, error } = await supa.from('cities').insert({
      city_slug: String(city_slug).toLowerCase(),
      name,
      country_code: country_code || null,
      status: status === 'draft' ? 'draft' : 'published',
      intro_text: intro_text ? String(intro_text).trim() : null,
    }).select().maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ ok: true, city: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/admin/cities/:id', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { name, country_code, status, intro_text } = req.body || {};
    const update = {};
    if (name != null) update.name = name;
    if (country_code != null) update.country_code = country_code || null;
    if (status === 'published' || status === 'draft') update.status = status;
    if (intro_text != null) update.intro_text = String(intro_text).trim() || null;
    const { data, error } = await supa.from('cities').update(update).eq('id', req.params.id).select().maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ ok: false, error: 'Stadt nicht gefunden' });
    res.json({ ok: true, city: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/admin/cities/:id', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { error } = await supa.from('cities').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/admin/cities/:id/translations', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data, error } = await supa.from('city_translations').select('language,name').eq('city_id', req.params.id);
    if (error) throw new Error(error.message);
    const translations = {};
    (data || []).forEach((r) => { translations[r.language] = r.name; });
    res.json({ ok: true, translations });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/admin/cities/:id/translations', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const entries = validateTranslationsPayload(req.body && req.body.translations);
    if (!entries.length) return res.json({ ok: true, updated: 0 });
    const rows = entries.map(([language, name]) => ({ city_id: req.params.id, language, name: String(name).trim() }));
    const { error } = await supa.from('city_translations').upsert(rows, { onConflict: 'city_id,language' });
    if (error) throw new Error(error.message);
    log('info', 'city_translations_updated', { city_id: req.params.id, languages: entries.map(([l]) => l) });
    res.json({ ok: true, updated: entries.length });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ─── Countries ───────────────────────────────────────────────
app.get('/admin/countries', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const q = (req.query.q || '').trim();
    const statusFilter = req.query.status;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = supa.from('countries').select('*', { count: 'exact' });
    if (statusFilter === 'published' || statusFilter === 'draft') query = query.eq('status', statusFilter);
    if (q) {
      const esc = q.replace(/[%_]/g, '\\$&');
      query = query.or(`name.ilike.%${esc}%,code.ilike.%${esc}%`);
    }
    query = query.order('name', { ascending: true }).range(from, to);

    const { data, error, count } = await query;
    if (error) throw new Error(error.message);
    const countries = await attachTranslationCounts('country_translations', 'country_code', data || [], 'code');
    res.json({ ok: true, countries, total: count || 0, page, limit, totalPages: Math.max(1, Math.ceil((count || 0) / limit)) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/countries', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { code, name, status, intro_text } = req.body || {};
    if (!code || !name) return res.status(400).json({ ok: false, error: 'code und name sind erforderlich' });
    const { data, error } = await supa.from('countries').insert({
      code: String(code).toUpperCase(),
      name,
      status: status === 'draft' ? 'draft' : 'published',
      intro_text: intro_text ? String(intro_text).trim() : null,
    }).select().maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ ok: true, country: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/admin/countries/:id', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { name, status, intro_text } = req.body || {};
    const update = {};
    if (name != null) update.name = name;
    if (status === 'published' || status === 'draft') update.status = status;
    if (intro_text != null) update.intro_text = String(intro_text).trim() || null;
    const { data, error } = await supa.from('countries').update(update).eq('id', req.params.id).select().maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ ok: false, error: 'Land nicht gefunden' });
    res.json({ ok: true, country: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/admin/countries/:id', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { error } = await supa.from('countries').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/admin/countries/:id/translations', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data: country, error: cErr } = await supa.from('countries').select('code').eq('id', req.params.id).maybeSingle();
    if (cErr) throw new Error(cErr.message);
    if (!country) return res.status(404).json({ ok: false, error: 'Land nicht gefunden' });
    const { data, error } = await supa.from('country_translations').select('language,name').eq('country_code', country.code);
    if (error) throw new Error(error.message);
    const translations = {};
    (data || []).forEach((r) => { translations[r.language] = r.name; });
    res.json({ ok: true, translations });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/admin/countries/:id/translations', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const entries = validateTranslationsPayload(req.body && req.body.translations);
    if (!entries.length) return res.json({ ok: true, updated: 0 });
    const { data: country, error: cErr } = await supa.from('countries').select('code').eq('id', req.params.id).maybeSingle();
    if (cErr) throw new Error(cErr.message);
    if (!country) return res.status(404).json({ ok: false, error: 'Land nicht gefunden' });
    const rows = entries.map(([language, name]) => ({ country_code: country.code, language, name: String(name).trim() }));
    const { error } = await supa.from('country_translations').upsert(rows, { onConflict: 'country_code,language' });
    if (error) throw new Error(error.message);
    log('info', 'country_translations_updated', { country_code: country.code, languages: entries.map(([l]) => l) });
    res.json({ ok: true, updated: entries.length });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// ─── Airports ────────────────────────────────────────────────
app.get('/admin/airports', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const q = (req.query.q || '').trim();
    const statusFilter = req.query.status;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = supa.from('airports').select('*', { count: 'exact' });
    if (statusFilter === 'published' || statusFilter === 'draft') query = query.eq('status', statusFilter);
    if (q) {
      const esc = q.replace(/[%_]/g, '\\$&');
      query = query.or(`airport_name.ilike.%${esc}%,iata_code.ilike.%${esc}%,icao_code.ilike.%${esc}%`);
    }
    query = query.order('iata_code', { ascending: true }).range(from, to);

    const { data, error, count } = await query;
    if (error) throw new Error(error.message);
    const airports = await attachTranslationCounts('airport_translations', 'airport_id', data || [], 'id');
    res.json({ ok: true, airports, total: count || 0, page, limit, totalPages: Math.max(1, Math.ceil((count || 0) / limit)) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/airports', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { iata_code, icao_code, airport_name, city_id, country_code, latitude, longitude, status, distance_to_city_center_km, transit_options, terminal_info, traveler_tips } = req.body || {};
    if (!iata_code || !airport_name) return res.status(400).json({ ok: false, error: 'iata_code und airport_name sind erforderlich' });
    const { data: dup } = await supa.from('airports').select('id').eq('iata_code', String(iata_code).toUpperCase()).maybeSingle();
    if (dup) return res.status(409).json({ ok: false, error: 'Ein Flughafen mit diesem IATA-Code existiert bereits' });
    const { data, error } = await supa.from('airports').insert({
      iata_code: String(iata_code).toUpperCase(),
      icao_code: icao_code || null,
      airport_name,
      city_id: city_id || null,
      country_code: country_code || null,
      latitude: latitude != null && latitude !== '' ? Number(latitude) : null,
      longitude: longitude != null && longitude !== '' ? Number(longitude) : null,
      status: status === 'draft' ? 'draft' : 'published',
      distance_to_city_center_km: distance_to_city_center_km != null && distance_to_city_center_km !== '' ? Number(distance_to_city_center_km) : null,
      transit_options: transit_options ? String(transit_options).trim() : null,
      terminal_info: terminal_info ? String(terminal_info).trim() : null,
      traveler_tips: traveler_tips ? String(traveler_tips).trim() : null,
    }).select().maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ ok: true, airport: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/admin/airports/:id', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { icao_code, airport_name, city_id, country_code, latitude, longitude, status, distance_to_city_center_km, transit_options, terminal_info, traveler_tips } = req.body || {};
    const update = { updated_at: new Date().toISOString() };
    if (icao_code != null) update.icao_code = icao_code || null;
    if (airport_name != null) update.airport_name = airport_name;
    if (city_id != null) update.city_id = city_id || null;
    if (country_code != null) update.country_code = country_code || null;
    if (latitude != null) update.latitude = latitude === '' ? null : Number(latitude);
    if (longitude != null) update.longitude = longitude === '' ? null : Number(longitude);
    if (status === 'published' || status === 'draft') update.status = status;
    if (distance_to_city_center_km != null) update.distance_to_city_center_km = distance_to_city_center_km === '' ? null : Number(distance_to_city_center_km);
    if (transit_options != null) update.transit_options = String(transit_options).trim() || null;
    if (terminal_info != null) update.terminal_info = String(terminal_info).trim() || null;
    if (traveler_tips != null) update.traveler_tips = String(traveler_tips).trim() || null;
    const { data, error } = await supa.from('airports').update(update).eq('id', req.params.id).select().maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ ok: false, error: 'Flughafen nicht gefunden' });
    res.json({ ok: true, airport: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/admin/airports/:id', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { error } = await supa.from('airports').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/admin/airports/:id/translations', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data, error } = await supa.from('airport_translations').select('language,name').eq('airport_id', req.params.id);
    if (error) throw new Error(error.message);
    const translations = {};
    (data || []).forEach((r) => { translations[r.language] = r.name; });
    res.json({ ok: true, translations });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/admin/airports/:id/translations', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const entries = validateTranslationsPayload(req.body && req.body.translations);
    if (!entries.length) return res.json({ ok: true, updated: 0 });
    const rows = entries.map(([language, name]) => ({ airport_id: req.params.id, language, name: String(name).trim() }));
    const { error } = await supa.from('airport_translations').upsert(rows, { onConflict: 'airport_id,language' });
    if (error) throw new Error(error.message);
    log('info', 'airport_translations_updated', { airport_id: req.params.id, languages: entries.map(([l]) => l) });
    res.json({ ok: true, updated: entries.length });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

};
