// ═════════════════════════════════════════════════════════════
// src/routes/alerts.routes.js
// [#18] تنبيهات الأسعار (saved_trips)
// ═════════════════════════════════════════════════════════════

const log = require('../utils/log');
const supa = require('../clients/supabase');
const rateLimit = require('../middleware/rateLimit');
const duffel = require('../services/duffel');
const { attachUserIfPresent } = require('../middleware/auth');

module.exports = (app) => {

app.post('/alerts', attachUserIfPresent, rateLimit('alerts', 20, 60000), async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ ok: false, error: 'Nicht angemeldet' });
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { origin, destination, departure_date, target_price } = req.body;
    if (!origin || !destination) return res.status(400).json({ ok: false, error: 'origin, destination مطلوبة' });
    const { data, error } = await supa.from('saved_trips').insert({
      user_id: req.userId, origin, destination,
      departure_date: departure_date || null,
      target_price: target_price ? Number(target_price) : null,
      active: true,
    }).select().maybeSingle();
    if (error) throw new Error(error.message);
    log('info', 'alert_created', { user_id: req.userId, origin, destination });
    res.json({ ok: true, alert: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/alerts', attachUserIfPresent, rateLimit('alerts', 60, 60000), async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ ok: false, error: 'Nicht angemeldet' });
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data, error } = await supa.from('saved_trips')
      .select('*').eq('user_id', req.userId).eq('active', true)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json({ ok: true, alerts: data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/alerts/:id/delete', attachUserIfPresent, rateLimit('alerts', 30, 60000), async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ ok: false, error: 'Nicht angemeldet' });
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { error } = await supa.from('saved_trips').delete()
      .eq('id', req.params.id).eq('user_id', req.userId);
    if (error) throw new Error(error.message);
    res.json({ ok: true, deleted: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/alerts/:id/check', attachUserIfPresent, rateLimit('alerts', 20, 60000), async (req, res) => {
  // Fare-alert price checks are retired. Airpiv only creates Duffel priced
  // offer requests from the real /search flow.
  if (!req.userId) return res.status(401).json({ ok: false, error: 'Nicht angemeldet' });
  return res.status(410).json({ ok: false, error: 'Preisalarme sind deaktiviert.' });
});
};
