// ═══════════════════════════════════════════════════════════════
// src/routes/admin-airlines.routes.js
// [AIRLINE-PAGES] CRUD for the airlines table, same requireAdmin tier
// and list/paginate/search/filter shape as admin-geo.routes.js's
// countries endpoints — airlines are auto-populated on-demand by
// ensureAirlineExists() (see routePages.js), same as cities/countries/
// airports; this just lets an admin edit the name/intro_text/status of
// an already-observed airline, or manually add/hide one.
// ═══════════════════════════════════════════════════════════════

const supa = require('../clients/supabase');
const rateLimit = require('../middleware/rateLimit');
const { requireAdmin } = require('../middleware/auth');

module.exports = (app) => {

app.get('/admin/airlines', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const q = (req.query.q || '').trim();
    const statusFilter = req.query.status;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = supa.from('airlines').select('*', { count: 'exact' });
    if (statusFilter === 'published' || statusFilter === 'draft') query = query.eq('status', statusFilter);
    if (q) {
      const esc = q.replace(/[%_]/g, '\\$&');
      query = query.or(`name.ilike.%${esc}%,iata_code.ilike.%${esc}%`);
    }
    query = query.order('name', { ascending: true }).range(from, to);

    const { data, error, count } = await query;
    if (error) throw new Error(error.message);
    res.json({ ok: true, airlines: data || [], total: count || 0, page, limit, totalPages: Math.max(1, Math.ceil((count || 0) / limit)) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/admin/airlines', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { iata_code, name, status, intro_text, country_code, hub_iata } = req.body || {};
    if (!iata_code || !name) return res.status(400).json({ ok: false, error: 'iata_code und name sind erforderlich' });
    const { data, error } = await supa.from('airlines').insert({
      iata_code: String(iata_code).toUpperCase(),
      name,
      status: status === 'draft' ? 'draft' : 'published',
      intro_text: intro_text ? String(intro_text).trim() : null,
      country_code: country_code ? String(country_code).toUpperCase() : null,
      hub_iata: hub_iata ? String(hub_iata).toUpperCase() : null,
    }).select().maybeSingle();
    if (error) throw new Error(error.message);
    res.json({ ok: true, airline: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/admin/airlines/:id', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { name, status, intro_text, country_code, hub_iata } = req.body || {};
    const update = {};
    if (name != null) update.name = name;
    if (status === 'published' || status === 'draft') update.status = status;
    if (intro_text != null) update.intro_text = String(intro_text).trim() || null;
    if (country_code != null) update.country_code = String(country_code).trim().toUpperCase() || null;
    if (hub_iata != null) update.hub_iata = String(hub_iata).trim().toUpperCase() || null;
    const { data, error } = await supa.from('airlines').update(update).eq('id', req.params.id).select().maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ ok: false, error: 'Airline nicht gefunden' });
    res.json({ ok: true, airline: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/admin/airlines/:id', rateLimit('admin', 120, 60000), requireAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { error } = await supa.from('airlines').delete().eq('id', req.params.id);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

};
