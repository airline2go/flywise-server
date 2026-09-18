const log = require('../utils/log');
const redis = require('../clients/redis');
const rateLimit = require('../middleware/rateLimit');
const { requireAdmin, attachUserIfPresent } = require('../middleware/auth');
const {
  searchGuard, createSearchSession, verifyTurnstile, clientIp, logSearchAccess,
} = require('../middleware/searchGuard');
const env = require('../config/env');
const duffel = require('../services/duffel');
const { getAdminConfig, setAdminConfig, getTicketProfitTiers, computeTieredMargin } = require('../services/adminConfig');
const { normalizeOffer } = require('../services/normalizeOffer');
const { getFareRulesByAirlines, logBaggageResolution } = require('../services/fareRulesStore');
const { ensureAirlineExists, ensureRouteAirlineObserved } = require('../services/routePages');
const { isExcludedCarrier } = require('../services/carrierFilter');
const supa = require('../clients/supabase');
const { PRICE_FRESHNESS_MS, buildPriceSnapshot } = require('../config/price');

const _apCache = new Map();
setInterval(() => {
  const cutoff = Date.now() - 300000;
  for (const [k, v] of _apCache) { if (v.t < cutoff) _apCache.delete(k); }
}, 300000).unref();

async function incrementDailyPriceCheckCounter() {
  if (!redis || redis.status !== 'ready') return;
  try {
    const key = 'daily_price_checks:' + new Date().toISOString().slice(0, 10);
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 25 * 60 * 60);
  } catch (e) { /* decorative */ }
}
async function getDailyPriceCheckCount() {
  if (!redis || redis.status !== 'ready') return null;
  try {
    const key = 'daily_price_checks:' + new Date().toISOString().slice(0, 10);
    const v = await redis.get(key);
    return v ? parseInt(v, 10) : 0;
  } catch (e) { return null; }
}

const ROUTE_PRICE_DUFFEL_OPTS = { timeoutMs: 12000 };

async function fetchAndCacheRoutePrice(from, to, daysAhead, cacheKey) {
  const searchDate = new Date();
  searchDate.setDate(searchDate.getDate() + daysAhead);
  const departure_date = searchDate.toISOString().slice(0, 10);

  const result = await duffel('POST', '/air/offer_requests?return_offers=true&supplier_timeout=8000', {
    data: {
      slices: [{ origin: from.toUpperCase(), destination: to.toUpperCase(), departure_date }],
      passengers: [{ type: 'adult' }],
      cabin_class: 'economy',
    },
  }, null, Object.assign({}, ROUTE_PRICE_DUFFEL_OPTS, {
    source: 'admin',
    logContext: { route_origin: from.toUpperCase(), route_destination: to.toUpperCase() },
  }));

  const offers = result.data?.offers || [];
  if (!offers.length) {
    const empty = { ok: true, price: null, currency: null, departure_date: null, insights: null, offersCount: 0, snapshot: buildPriceSnapshot({ source: 'none' }) };
    return empty;
  }

  function isoMinutesToHours(iso) {
    const m = String(iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
    if (!m) return null;
    return (parseInt(m[1] || 0, 10) * 60) + parseInt(m[2] || 0, 10);
  }

  const ticketTiers = await getTicketProfitTiers();
  const priced = offers.map((o) => {
    const netPrice = parseFloat(o.total_amount || 0);
    const margin = computeTieredMargin(netPrice, ticketTiers);
    const price = Math.round((netPrice + margin) * 100) / 100;
    const slice = (o.slices || [])[0];
    const durationMin = slice ? isoMinutesToHours(slice.duration) : null;
    const segs = slice ? (slice.segments || []) : [];
    const stops = slice ? Math.max(0, segs.length - 1) : null;
    const mc = segs[0] && segs[0].marketing_carrier;
    const airline = (mc && mc.name && !isExcludedCarrier(mc.iata_code, mc.name)) ? mc.name : null;
    return { id: o.id, price, durationMin, stops, airline };
  });
  const { cheapest, fastest, bestValue } = selectRouteOffers(priced);

  const durations = [];
  const stopCounts = [];
  const airlines = new Set();
  const airlinesObserved = new Map();
  for (const o of offers) {
    const slice = (o.slices || [])[0];
    if (!slice) continue;
    const durMin = isoMinutesToHours(slice.duration);
    if (durMin != null) durations.push(durMin);
    const segs = slice.segments || [];
    stopCounts.push(Math.max(0, segs.length - 1));
    segs.forEach((s) => {
      const carrierName = s.marketing_carrier?.name;
      const carrierIata = s.marketing_carrier?.iata_code;
      if (isExcludedCarrier(carrierIata, carrierName)) return;
      if (carrierName) airlines.add(carrierName);
      if (carrierIata) airlinesObserved.set(carrierIata, carrierName);
    });
  }
  const insights = durations.length ? {
    avgDurationMin: avgDurationExcludingOutliers(durations),
    minDurationMin: Math.min(...durations),
    directAvailable: stopCounts.some((s) => s === 0),
    allDirect: stopCounts.every((s) => s === 0),
    airlines: Array.from(airlines).slice(0, 8),
  } : null;

  if (insights && supa) {
    const stopDistribution = stopCounts.reduce((acc, s) => { acc[s] = (acc[s] || 0) + 1; return acc; }, {});
    supa.from('route_pages').update({
      direct_flight_available: insights.directAvailable,
      all_direct: insights.allDirect,
      avg_duration_min: insights.avgDurationMin,
      min_duration_min: insights.minDurationMin,
      stop_distribution: stopDistribution,
      itinerary_count: offers.length,
      insights_updated_at: new Date().toISOString(),
    }).eq('origin_iata', from.toUpperCase()).eq('destination_iata', to.toUpperCase())
      .then(() => {}).catch(() => {});
  }

  airlinesObserved.forEach((name, iataCode) => {
    ensureAirlineExists(iataCode, name)
      .then((airlineId) => { if (airlineId) return ensureRouteAirlineObserved(from.toUpperCase(), to.toUpperCase(), airlineId); })
      .catch(() => {});
  });

  const currency = offers[0].total_currency || 'EUR';
  const routeOffers = { cheapest, fastest, bestValue };

  if (supa && cheapest && cheapest.price != null) {
    supa.from('route_price_history').insert({
      route_origin_iata: from.toUpperCase(),
      route_destination_iata: to.toUpperCase(),
      price: cheapest.price,
      currency,
      offer_count: offers.length,
    }).then(() => {}).catch(() => {});
  }

  const fetchedAt = new Date().toISOString();
  await setAdminConfig(cacheKey, { price: cheapest.price, currency, departure_date, insights, offers: routeOffers, offersCount: offers.length, fetchedAt });
  await incrementDailyPriceCheckCounter();
  const checksToday = await getDailyPriceCheckCount();
  const snapshot = buildPriceSnapshot({ price: cheapest.price, currency, checkedAt: fetchedAt, source: 'live', offersCount: offers.length });
  return { ok: true, price: cheapest.price, currency, departure_date, insights, offers: routeOffers, cached: false, checksToday, checkedAt: fetchedAt, offersCount: offers.length, snapshot };
}

const BEST_VALUE_WEIGHTS = { price: 0.5, duration: 0.3, stops: 0.2 };
function selectRouteOffers(priced) {
  const cheapest = priced.reduce((a, b) => (b.price < a.price ? b : a));
  const withDuration = priced.filter((p) => p.durationMin != null);
  if (!withDuration.length) return { cheapest, fastest: cheapest, bestValue: cheapest };
  const fastest = withDuration.reduce((a, b) => (b.durationMin < a.durationMin ? b : a));
  const prices = withDuration.map((p) => p.price);
  const durations = withDuration.map((p) => p.durationMin);
  const minP = Math.min(...prices), maxP = Math.max(...prices);
  const minD = Math.min(...durations), maxD = Math.max(...durations);
  let bestValue = withDuration[0];
  let bestScore = Infinity;
  for (const p of withDuration) {
    const normPrice = maxP === minP ? 0 : (p.price - minP) / (maxP - minP);
    const normDuration = maxD === minD ? 0 : (p.durationMin - minD) / (maxD - minD);
    const normStops = Math.min((p.stops || 0) / 2, 1);
    const score = normPrice * BEST_VALUE_WEIGHTS.price + normDuration * BEST_VALUE_WEIGHTS.duration + normStops * BEST_VALUE_WEIGHTS.stops;
    if (score < bestScore) { bestScore = score; bestValue = p; }
  }
  return { cheapest, fastest, bestValue };
}

const ROUTE_PRICE_WARM_BATCH_SIZE = 25;
const ROUTE_PRICE_WARM_DELAY_MS = 2000;
const ROUTE_PRICE_WARM_INTERVAL_MS = 15 * 60 * 1000;
const REFRESH_FREQUENCY_MS = { '6h': 6 * 60 * 60 * 1000, '12h': 12 * 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000 };

async function warmRoutePricesOnce() {
  if (!supa) return;
  try {
    const { data: routes, error } = await supa.from('route_pages')
      .select('origin_iata,destination_iata,refresh_frequency')
      .eq('status', 'published')
      .neq('refresh_frequency', 'none');
    if (error || !routes || !routes.length) return;
    const byPair = new Map();
    for (const r of routes) {
      if (!r.origin_iata || !r.destination_iata) continue;
      const thresholdMs = REFRESH_FREQUENCY_MS[r.refresh_frequency];
      if (!thresholdMs) continue;
      const key = r.origin_iata.toUpperCase() + '_' + r.destination_iata.toUpperCase();
      const existing = byPair.get(key);
      if (!existing || thresholdMs < existing.thresholdMs) {
        byPair.set(key, { from: r.origin_iata, to: r.destination_iata, cacheKey: 'route_price_' + key, thresholdMs });
      }
    }
    const pairs = Array.from(byPair.values());
    let warmedThisCycle = 0;
    for (const p of pairs) {
      if (warmedThisCycle >= ROUTE_PRICE_WARM_BATCH_SIZE) break;
      let due = true;
      try {
        const cached = await getAdminConfig(p.cacheKey, null);
        if (cached && cached.fetchedAt && (Date.now() - new Date(cached.fetchedAt).getTime()) < p.thresholdMs) due = false;
      } catch (e) { /* treat as due */ }
      if (!due) continue;
      try {
        await fetchAndCacheRoutePrice(p.from, p.to, 21, p.cacheKey);
        log('info', 'route_price_warmed', { from: p.from, to: p.to });
      } catch (e) {
        log('warn', 'route_price_warm_failed', { from: p.from, to: p.to, error: e.message });
      }
      warmedThisCycle++;
      await new Promise((r) => setTimeout(r, ROUTE_PRICE_WARM_DELAY_MS));
    }
  } catch (e) {
    log('warn', 'route_price_warm_cycle_failed', { error: e.message });
  }
}

if (env.DUFFEL_BACKGROUND_SEARCH_ENABLED) {
  setTimeout(() => { warmRoutePricesOnce(); }, 30000).unref();
  setInterval(() => { warmRoutePricesOnce(); }, ROUTE_PRICE_WARM_INTERVAL_MS).unref();
}

const DURATION_OUTLIER_MULTIPLE = 3;
function avgDurationExcludingOutliers(durations) {
  if (!durations || !durations.length) return null;
  const min = Math.min(...durations);
  const cap = min * DURATION_OUTLIER_MULTIPLE;
  const trimmed = durations.filter((d) => d <= cap);
  const source = trimmed.length ? trimmed : durations;
  return Math.round(source.reduce((a, b) => a + b, 0) / source.length);
}

const _publishedRouteCache = { t: 0, map: new Map() };
const PUBLISHED_ROUTE_CACHE_MS = 60000;

async function isPublishedRoute(from, to) {
  const origin = String(from || '').toUpperCase();
  const dest = String(to || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(dest)) return false;
  const pair = origin + '_' + dest;
  const hit = _publishedRouteCache.map.get(pair);
  if (hit && (Date.now() - hit.t) < PUBLISHED_ROUTE_CACHE_MS) return hit.ok;
  if (!supa) {
    _publishedRouteCache.map.set(pair, { t: Date.now(), ok: false });
    return false;
  }
  try {
    const { data, error } = await supa.from('route_pages')
      .select('origin_iata,destination_iata')
      .eq('status', 'published');
    let ok = false;
    if (!error && Array.isArray(data)) {
      ok = data.some((r) =>
        String(r.origin_iata || '').toUpperCase() === origin &&
        String(r.destination_iata || '').toUpperCase() === dest
      );
    }
    _publishedRouteCache.map.set(pair, { t: Date.now(), ok });
    return ok;
  } catch (e) {
    return false;
  }
}

function duffelSearchOpts(req, source, extra) {
  return Object.assign({
    source,
    searchContext: {
      valid: !!(req.searchSession && req.searchSession.valid),
      sid: req.searchSession && req.searchSession.sid,
      userId: req.userId || null,
      ip: clientIp(req),
    },
  }, extra || {});
}

module.exports = (app) => {
app.post('/search/session', rateLimit('search-session', 10, 60000), async (req, res) => {
  try {
    const ip = clientIp(req);
    const ts = await verifyTurnstile(req.body && req.body.turnstile_token, ip);
    if (!ts.ok) {
      logSearchAccess({
        endpoint: '/search/session', source: 'session_issue', sid: null, ip,
        allowed: false, reason: ts.reason || 'turnstile_failed',
      });
      return res.status(403).json({ ok: false, error: 'Suche nicht verfügbar. Bitte Seite neu laden.' });
    }
    const session = createSearchSession();
    logSearchAccess({
      endpoint: '/search/session', source: 'session_issue', sid: session.sid, ip, allowed: true,
    });
    res.json({ ok: true, token: session.token, expires_at: session.exp });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Suche nicht verfügbar. Bitte Seite neu laden.' });
  }
});

app.get('/debug/raw', requireAdmin, rateLimit('pay', 10, 60000), async (req, res) => {
  try {
    const { origin, destination, departure_date, cabin_class = 'economy' } = req.query;
    if (!origin || !destination || !departure_date) {
      return res.status(400).json({ ok: false, error: 'use ?origin=BER&destination=ORD&departure_date=2026-06-25' });
    }
    const result = await duffel('POST', '/air/offer_requests?return_offers=true', {
      data: { slices: [{ origin, destination, departure_date }], passengers: [{ type: 'adult' }], cabin_class },
    }, null, { source: 'admin' });
    const offers = result.data?.offers || [];
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
    res.json({ ok: true, total_offers: offers.length, fare_summary: summary, first_offer_raw: offers[0] || null });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message, details: err.details });
  }
});

const SEARCH_CACHE_TTL_MS = 120000;
async function getSharedSearchCache(cacheKey) {
  if (!redis || redis.status !== 'ready') return null;
  try {
    const raw = await redis.get('search_cache:v2:' + cacheKey);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}
async function setSharedSearchCache(cacheKey, data) {
  if (!redis || redis.status !== 'ready') return;
  try {
    await redis.set('search_cache:v2:' + cacheKey, JSON.stringify(data), 'EX', Math.ceil(SEARCH_CACHE_TTL_MS / 1000));
  } catch (e) { /* cache is best-effort */ }
}
const _searchCache = new Map();
setInterval(() => {
  const cutoff = Date.now() - SEARCH_CACHE_TTL_MS;
  for (const [k, v] of _searchCache) { if (v.t < cutoff) _searchCache.delete(k); }
}, SEARCH_CACHE_TTL_MS).unref();

app.post('/search', attachUserIfPresent, searchGuard({
  bucket: 'search', source: 'user_search',
  ipMax: 30, ipWindowMs: 60000,
  sessionMax: 15, sessionWindowMs: 60000,
}), async (req, res) => {
  try {
    const {
      origin, destination, departure_date,
      return_date, cabin_class = 'economy',
      adults = 1, children = 0, infants = 0,
      slices: bodySlices,
    } = req.body;

    const normalizedSlices = Array.isArray(bodySlices)
      ? bodySlices.map((s) => ({
        origin: String(s?.origin || '').trim().toUpperCase(),
        destination: String(s?.destination || '').trim().toUpperCase(),
        departure_date: String(s?.departure_date || '').trim(),
      }))
      : null;
    const searchCacheKey = JSON.stringify({
      origin: String(origin || '').trim().toUpperCase(),
      destination: String(destination || '').trim().toUpperCase(),
      departure_date: String(departure_date || '').trim(),
      return_date: String(return_date || '').trim(),
      cabin_class: String(cabin_class || 'economy').toLowerCase(),
      adults: Number(adults) || 1,
      children: Number(children) || 0,
      infants: Number(infants) || 0,
      bodySlices: normalizedSlices,
    });
    const cachedSearch = _searchCache.get(searchCacheKey);
    if (cachedSearch && (Date.now() - cachedSearch.t) < SEARCH_CACHE_TTL_MS) {
      return res.json(cachedSearch.data);
    }
    const sharedCachedSearch = await getSharedSearchCache(searchCacheKey);
    if (sharedCachedSearch) {
      _searchCache.set(searchCacheKey, { t: Date.now(), data: sharedCachedSearch });
      return res.json(sharedCachedSearch);
    }

    const passengers = [];
    for (let i = 0; i < adults; i++) passengers.push({ type: 'adult' });
    for (let i = 0; i < children; i++) passengers.push({ type: 'child' });
    for (let i = 0; i < infants; i++) passengers.push({ type: 'infant_without_seat' });

    let slices;
    if (Array.isArray(bodySlices) && bodySlices.length) {
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

    const result = await duffel('POST', '/air/offer_requests?return_offers=true&supplier_timeout=8000', {
      data: { slices, passengers, cabin_class },
    }, null, duffelSearchOpts(req, 'user_search', ROUTE_PRICE_DUFFEL_OPTS));

    const ticketTiers = await getTicketProfitTiers();
    const rawOffers = result.data?.offers || [];
    const carrierCodes = [...new Set(rawOffers
      .map((o) => o?.slices?.[0]?.segments?.[0]?.marketing_carrier?.iata_code)
      .filter(Boolean))];
    let fareRulesByAirline = {};
    try {
      fareRulesByAirline = await getFareRulesByAirlines(carrierCodes);
    } catch (_) { fareRulesByAirline = {}; }
    const offers = rawOffers.map((o) => normalizeOffer(o, ticketTiers, fareRulesByAirline));
    try {
      for (const off of offers) {
        if (off && off.baggage) logBaggageResolution(off.id, off.baggage.meta && off.baggage.meta.ctx || {}, off.baggage);
      }
    } catch (_) { /* observability must never break search */ }

    const responseData = { ok: true, offer_request_id: result.data?.id, offers, total: offers.length };
    _searchCache.set(searchCacheKey, { t: Date.now(), data: responseData });
    await setSharedSearchCache(searchCacheKey, responseData);
    res.json(responseData);
    incrementDailyPriceCheckCounter();
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message, details: err.details });
  }
});

app.get('/route-price', rateLimit('route-price', 60, 60000), async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ ok: false, error: 'from und to sind erforderlich' });
    const origin = String(from).toUpperCase();
    const dest = String(to).toUpperCase();
    const allowed = await isPublishedRoute(origin, dest);
    if (!allowed) {
      logSearchAccess({
        endpoint: '/route-price', source: 'route_price', ip: clientIp(req),
        route: origin + '-' + dest, allowed: false, reason: 'route_not_allowed',
      });
      return res.status(403).json({ ok: false, error: 'Route nicht verfügbar.' });
    }
    const daysAhead = req.query.days_ahead ? Math.max(1, Math.min(90, parseInt(req.query.days_ahead, 10) || 21)) : 21;
    const cacheKey = 'route_price_' + origin + '_' + dest + (daysAhead !== 21 ? '_d' + daysAhead : '');
    const cached = await getAdminConfig(cacheKey, null);
    const cacheAgeMs = cached && cached.fetchedAt ? (Date.now() - new Date(cached.fetchedAt).getTime()) : Infinity;
    if (cached) {
      const checksToday = await getDailyPriceCheckCount();
      const stale = cacheAgeMs >= PRICE_FRESHNESS_MS;
      const snapshot = buildPriceSnapshot({
        price: cached.price, currency: cached.currency, checkedAt: cached.fetchedAt,
        source: stale ? 'stale-cache' : 'cache', offersCount: cached.offersCount,
      });
      return res.json({
        ok: true, price: cached.price, currency: cached.currency,
        departure_date: cached.departure_date, insights: cached.insights || null,
        offers: cached.offers || null, cached: true, stale: stale || undefined,
        checksToday, checkedAt: cached.fetchedAt, offersCount: cached.offersCount ?? null, snapshot,
      });
    }
    logSearchAccess({
      endpoint: '/route-price', source: 'route_price', ip: clientIp(req),
      route: origin + '-' + dest, allowed: true, reason: 'cache_miss_no_duffel',
    });
    res.json({
      ok: true, price: null, currency: null, departure_date: null,
      snapshot: buildPriceSnapshot({ source: 'none' }),
    });
  } catch (err) {
    log('warn', 'route_price_failed', { error: err.message });
    res.json({ ok: true, price: null, currency: null, departure_date: null });
  }
});

app.get('/search/airports', attachUserIfPresent, searchGuard({
  bucket: 'airports', source: 'airport_search',
  ipMax: 30, ipWindowMs: 60000,
  sessionMax: 30, sessionWindowMs: 60000,
}), async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (q.length < 2) return res.json({ ok: true, airports: [] });
    const key = q.toLowerCase();
    const hit = _apCache.get(key);
    if (hit && (Date.now() - hit.t) < 300000) {
      return res.json({ ok: true, airports: hit.data });
    }
    const result = await duffel('GET', '/places/suggestions?query=' + encodeURIComponent(q), null, null, duffelSearchOpts(req, 'airport_search'));
    const out = [];
    const seen = new Set();
    const push = (o) => { const k = o.type + ':' + o.code; if (o.code && !seen.has(k)) { seen.add(k); out.push(o); } };
    (result.data || []).forEach((p) => {
      if (p.type === 'city') {
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
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ ok: true, airports: out });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message, airports: [] });
  }
});
};
module.exports.warmRoutePricesOnce = warmRoutePricesOnce;
module.exports.selectRouteOffers = selectRouteOffers;
module.exports.avgDurationExcludingOutliers = avgDurationExcludingOutliers;
module.exports.fetchAndCacheRoutePrice = fetchAndCacheRoutePrice;
module.exports.isPublishedRoute = isPublishedRoute;
module.exports.resetPublishedRouteCache = function () { _publishedRouteCache.map.clear(); };
