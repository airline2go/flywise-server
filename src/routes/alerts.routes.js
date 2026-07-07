// ═══════════════════════════════════════════════════════════════
// src/routes/alerts.routes.js
// [#18] تنبيهات الأسعار (saved_trips) — حفظ مسار للمتابعة، عرض
// تنبيهات المستخدم، حذف/تعطيل، وفحص السعر الحي لمسار محفوظ.
// ═══════════════════════════════════════════════════════════════

const log = require('../utils/log');
const supa = require('../clients/supabase');
const rateLimit = require('../middleware/rateLimit');
const duffel = require('../services/duffel');
const { attachUserIfPresent } = require('../middleware/auth');

module.exports = (app) => {

// [IDOR-FIX] Saved-trip alerts are per-account data — every route below
// requires a verified Supabase auth token (attachUserIfPresent +
// req.userId check) and always scopes the query to req.userId, never to
// a client-supplied user_id. Mirrors the same pattern already used by
// /my-bookings in auth.routes.js.
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

// List the caller's own saved routes
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

// Delete / deactivate a saved route (only if it belongs to the caller)
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

// Live cheapest-price check for a saved route (also updates last_price) —
// only for a route the caller owns.
app.post('/alerts/:id/check', attachUserIfPresent, rateLimit('alerts', 20, 60000), async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ ok: false, error: 'Nicht angemeldet' });
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data: trip, error } = await supa.from('saved_trips').select('*').eq('id', req.params.id).eq('user_id', req.userId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!trip) return res.status(404).json({ ok: false, error: 'Route nicht gefunden' });

    const offerReq = await duffel('POST', '/air/offer_requests?return_offers=true', {
      data: {
        slices: [{ origin: trip.origin, destination: trip.destination, departure_date: trip.departure_date }],
        passengers: [{ type: 'adult' }],
        cabin_class: 'economy',
      },
    });
    const offers = (offerReq.data && offerReq.data.offers) || [];
    let cheapest = null;
    offers.forEach((o) => { const p = parseFloat(o.total_amount); if (cheapest === null || p < cheapest) cheapest = p; });

    if (cheapest !== null) {
      supa.from('saved_trips').update({ last_price: cheapest }).eq('id', trip.id).then(function(){}, function(){});
    }
    const hitTarget = (trip.target_price && cheapest !== null) ? cheapest <= Number(trip.target_price) : false;
    res.json({ ok: true, cheapest_price: cheapest, currency: 'EUR', target_price: trip.target_price, target_reached: hitTarget });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});
};
