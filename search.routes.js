// ═══════════════════════════════════════════════════════════════
// src/routes/search.routes.js
// /search (بحث الرحلات الرئيسي)، /route-price (سعر تقديري لصفحات
// SEO، كاش 6 ساعات)، /search/airports (بحث حي عن المطارات، كاش
// 5 دقائق)، /debug/raw (تشخيصي، محمي بالأدمن).
// ═══════════════════════════════════════════════════════════════

const log = require('../utils/log');
const rateLimit = require('../middleware/rateLimit');
const { requireAdmin } = require('../middleware/auth');
const duffel = require('../services/duffel');
const { getAdminConfig, setAdminConfig, getTicketProfitTiers, computeTieredMargin } = require('../services/adminConfig');
const { normalizeOffer } = require('../services/normalizeOffer');

// [MEMORY-LEAK-FIX] كاش 5 دقائق لبحث المطارات — بينضف نفسه دوري
// كل 5 دقائق عشان مايتراكمش مصطلحات بحث قديمة للأبد.
const _apCache = new Map();
setInterval(() => {
  const cutoff = Date.now() - 300000;
  for (const [k, v] of _apCache) { if (v.t < cutoff) _apCache.delete(k); }
}, 300000).unref();

module.exports = (app) => {
app.get('/debug/raw', requireAdmin, rateLimit('pay', 10, 60000), async (req, res) => {
  try {
    const { origin, destination, departure_date, cabin_class = 'economy' } = req.query;
    if (!origin || !destination || !departure_date) {
      return res.status(400).json({ ok: false, error: 'use ?origin=BER&destination=ORD&departure_date=2026-06-25' });
    }
    const result = await duffel('POST', '/air/offer_requests?return_offers=true', {
      data: {
        slices: [{ origin, destination, departure_date }],
        passengers: [{ type: 'adult' }],
        cabin_class
      },
    });
    const offers = result.data?.offers || [];
    // Return the first 3 offers raw, plus a focused summary of the fare-related fields
    const summary = offers.slice(0, 5).map(o => {
      const seg0 = o.slices?.[0]?.segments?.[0];
      const pax0 = seg0?.passengers?.[0];
      return {
        total_amount: o.total_amount,
        fare_brand_name: o.fare_brand_name || null,
        slice_fare_brand: o.slices?.[0]?.fare_brand_name || null,
        seg_cabin_class: pax0?.cabin_class || null,
        seg_cabin_marketing: pax0?.cabin_class_marketing_name || null,
        cabin_amenities: pax0?.cabin?.amenities || null,
        conditions: o.conditions || null,
      };
    });
    res.json({
      ok: true,
      total_offers: offers.length,
      fare_summary: summary,
      first_offer_raw: offers[0] || null
    });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message, details: err.details });
  }
});

app.post('/search', rateLimit('search', 30, 60000), async (req, res) => {
  try {
    const {
      origin, destination, departure_date,
      return_date, cabin_class = 'economy',
      adults = 1, children = 0, infants = 0,
      slices: bodySlices,
    } = req.body;

    const passengers = [];
    for (let i = 0; i < adults; i++) passengers.push({ type: 'adult' });
    for (let i = 0; i < children; i++) passengers.push({ type: 'child' });
    for (let i = 0; i < infants; i++) passengers.push({ type: 'infant_without_seat' });

    // Build slices: either multi-city (slices provided) or simple one-way/return
    let slices;
    if (Array.isArray(bodySlices) && bodySlices.length) {
      // Multi-city: accept the slices the client built, keep only valid legs
      slices = bodySlices
        .filter((s) => s && s.origin && s.destination && s.departure_date)
        .map((s) => ({ origin: s.origin, destination: s.destination, departure_date: s.departure_date }));
      if (!slices.length) {
        return res.status(400).json({ ok: false, error: 'slices غير صالحة (origin/destination/departure_date مطلوبة لكل مقطع)' });
      }
    } else {
      if (!origin || !destination || !departure_date) {
        return res.status(400).json({ ok: false, error: 'origin, destination, departure_date مطلوبة' });
      }
      slices = [{ origin, destination, departure_date }];
      if (return_date) slices.push({ origin: destination, destination: origin, departure_date: return_date });
    }

    const result = await duffel('POST', '/air/offer_requests?return_offers=true', {
      data: { slices, passengers, cabin_class },
    });

    // [PRICING-FIX] Fetch the tiers ONCE for this whole search response —
    // a single search can return dozens of offers, and they all share the
    // same admin-configured margin tiers at this moment in time.
    const ticketTiers = await getTicketProfitTiers();
    const offers = (result.data?.offers || []).map((o) => normalizeOffer(o, ticketTiers));

    res.json({ ok: true, offer_request_id: result.data?.id, offers, total: offers.length });

  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message, details: err.details });
  }
});

app.get('/route-price', rateLimit('route-price', 60, 60000), async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ ok: false, error: 'from und to sind erforderlich' });

    const cacheKey = 'route_price_' + from.toUpperCase() + '_' + to.toUpperCase();
    const cached = await getAdminConfig(cacheKey, null);
    if (cached && cached.fetchedAt && (Date.now() - new Date(cached.fetchedAt).getTime()) < 6 * 60 * 60 * 1000) {
      // [DATE-MATCH-FIX] Return the EXACT date this cached price was
      // computed for — never recomputed as "today + 21" on a cache hit,
      // which could point a few hours/days later to a different date
      // than the one that actually produced this price.
      // [ROUTE-INSIGHTS] insights defaults to null for entries cached
      // before this field existed — safe fallback, never a crash.
      return res.json({ ok: true, price: cached.price, currency: cached.currency, departure_date: cached.departure_date, insights: cached.insights || null, cached: true });
    }

    // A representative near-future date — NOT today, which would surface
    // artificially high last-minute fares that don't reflect a typical
    // "from" price for the route.
    const searchDate = new Date();
    searchDate.setDate(searchDate.getDate() + 21);
    const departure_date = searchDate.toISOString().slice(0, 10);

    const result = await duffel('POST', '/air/offer_requests?return_offers=true', {
      data: {
        slices: [{ origin: from.toUpperCase(), destination: to.toUpperCase(), departure_date }],
        passengers: [{ type: 'adult' }],
        cabin_class: 'economy',
      },
    });

    const offers = result.data?.offers || [];
    if (!offers.length) {
      return res.json({ ok: true, price: null, currency: null, departure_date: null, insights: null });
    }

    const ticketTiers = await getTicketProfitTiers();
    let cheapest = null;
    for (const o of offers) {
      const netPrice = parseFloat(o.total_amount || 0);
      const margin = computeTieredMargin(netPrice, ticketTiers);
      const customerPrice = Math.round((netPrice + margin) * 100) / 100;
      if (cheapest === null || customerPrice < cheapest) cheapest = customerPrice;
    }

    // [ROUTE-INSIGHTS] Real flight facts pulled from the SAME Duffel
    // offers already fetched above for pricing — duration, stop count,
    // and actual operating airlines for this specific route. Previously
    // every field except total_amount was discarded. These are the
    // figures the route page's new "Route Insights" section displays —
    // every one computed from real data for this exact origin/
    // destination pair, never invented or generic boilerplate.
    function isoMinutesToHours(iso) {
      const m = String(iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
      if (!m) return null;
      return (parseInt(m[1] || 0, 10) * 60) + parseInt(m[2] || 0, 10);
    }
    const durations = [];
    const stopCounts = [];
    const airlines = new Set();
    for (const o of offers) {
      const slice = (o.slices || [])[0];
      if (!slice) continue;
      const durMin = isoMinutesToHours(slice.duration);
      if (durMin != null) durations.push(durMin);
      const segs = slice.segments || [];
      stopCounts.push(Math.max(0, segs.length - 1));
      segs.forEach((s) => { if (s.marketing_carrier?.name) airlines.add(s.marketing_carrier.name); });
    }
    const insights = durations.length ? {
      avgDurationMin: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
      minDurationMin: Math.min(...durations),
      directAvailable: stopCounts.some((s) => s === 0),
      allDirect: stopCounts.every((s) => s === 0),
      airlines: Array.from(airlines).slice(0, 8), // cap — purely defensive, real routes rarely exceed this
    } : null;

    await setAdminConfig(cacheKey, { price: cheapest, currency: offers[0].total_currency || 'EUR', departure_date, insights, fetchedAt: new Date().toISOString() });
    res.json({ ok: true, price: cheapest, currency: offers[0].total_currency || 'EUR', departure_date, insights, cached: false });
  } catch (err) {
    // Fail soft — a route page should still render (without a price) if
    // Duffel is briefly unavailable, never show a broken page.
    log('warn', 'route_price_failed', { error: err.message });
    res.json({ ok: true, price: null, currency: null, departure_date: null });
  }
});

app.get('/search/airports', rateLimit('airports', 60, 60000), async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (q.length < 2) return res.json({ ok: true, airports: [] });

    const key = q.toLowerCase();
    const hit = _apCache.get(key);
    if (hit && (Date.now() - hit.t) < 300000) {
      return res.json({ ok: true, airports: hit.data });
    }

    const result = await duffel('GET', '/places/suggestions?query=' + encodeURIComponent(q));

    const out = [];
    const seen = new Set();
    const push = (o) => { if (o.code && !seen.has(o.code)) { seen.add(o.code); out.push(o); } };
    (result.data || []).forEach((p) => {
      if (p.type === 'city') {
        // [ROUTE-PAGES] Cities deliberately get no lat/lng — a city can
        // span multiple airports at different points, so there's no
        // single coordinate that accurately represents it. Only
        // individual airports (below) carry coordinates, which is what
        // route-distance calculations actually need anyway (search is by
        // airport code, never by city code).
        push({ type: 'city', code: p.iata_code, name: p.name, city: p.name, country: p.iata_country_code });
        (p.airports || []).forEach((ap) => push({
          type: 'airport', code: ap.iata_code, name: ap.name,
          city: ap.city_name || p.name, country: ap.iata_country_code || p.iata_country_code,
          lat: ap.latitude != null ? Number(ap.latitude) : null,
          lng: ap.longitude != null ? Number(ap.longitude) : null,
        }));
      } else {
        push({
          type: 'airport', code: p.iata_code, name: p.name,
          city: p.city_name || (p.city && p.city.name) || p.name, country: p.iata_country_code,
          lat: p.latitude != null ? Number(p.latitude) : null,
          lng: p.longitude != null ? Number(p.longitude) : null,
        });
      }
    });

    _apCache.set(key, { t: Date.now(), data: out });
    res.set('Cache-Control', 'public, max-age=3600'); // المتصفح يخزّن نتائج المطارات ساعة
    res.json({ ok: true, airports: out });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message, airports: [] });
  }
});
};
