const rateLimit = require('./rateLimit');
const { clientIp, logSearchAccess } = require('./searchGuard');
const duffel = require('../services/duffel');
const { isPublishedRoute } = require('../routes/search.routes');
const { getAdminConfig, setAdminConfig } = require('../services/adminConfig');
const { PRICE_FRESHNESS_MS, buildPriceSnapshot } = require('../config/price');

const BOT_UA = /bot|crawler|spider|slurp|bingpreview|google-extended|googleother|adsbot|mediapartners-google|facebookexternalhit|facebot|twitterbot|linkedinbot|slackbot|discordbot|telegrambot|whatsapp|gptbot|chatgpt-user|oai-searchbot|anthropic|claude|perplexity|semrush|ahrefs|petalbot|bytespider|yandex|baiduspider|duckduckbot|applebot|curl|wget|python-requests|python-httpx|node-fetch|axios|okhttp|headlesschrome|puppeteer|playwright|lighthouse|pagespeed|pingdom|uptimerobot|statuscake/i;
const inFlight = new Map();

function isRealBrowser(req) {
  const ua = String(req.get('user-agent') || '');
  if (!ua || BOT_UA.test(ua)) return false;
  const mode = String(req.get('sec-fetch-mode') || '').toLowerCase();
  const dest = String(req.get('sec-fetch-dest') || '').toLowerCase();
  return mode === 'cors' || mode === 'same-origin' || dest === 'empty';
}

function durationMinutes(iso) {
  const m = String(iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  return m ? parseInt(m[1] || 0, 10) * 60 + parseInt(m[2] || 0, 10) : null;
}

async function fetchLiveRoutePrice(from, to, daysAhead, cacheKey) {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  const departure_date = date.toISOString().slice(0, 10);
  const result = await duffel('POST', '/air/offer_requests?return_offers=true&supplier_timeout=8000', {
    data: {
      slices: [{ origin: from, destination: to, departure_date }],
      passengers: [{ type: 'adult' }],
      cabin_class: 'economy',
    },
  }, null, {
    timeoutMs: 12000,
    source: 'route_price_user_visit',
    trigger: 'route_price_user_visit',
    logContext: { route_origin: from, route_destination: to },
  });

  const offers = result.data?.offers || [];
  const priced = offers.map((o) => {
    const price = Number(o.total_amount);
    const slice = o.slices?.[0];
    const durationMin = slice ? durationMinutes(slice.duration) : null;
    const stops = Math.max(0, (slice?.segments || []).length - 1);
    return { id: o.id, price, durationMin, stops };
  }).filter((o) => Number.isFinite(o.price) && o.price > 0);

  if (!priced.length) return { ok: true, price: null, currency: null, departure_date: null, offersCount: 0, snapshot: buildPriceSnapshot({ source: 'none' }) };

  const cheapest = priced.reduce((a, b) => b.price < a.price ? b : a);
  const durations = priced.map((o) => o.durationMin).filter((v) => v != null);
  const stopCounts = priced.map((o) => o.stops);
  const currency = offers.find((o) => o.total_currency)?.total_currency || 'EUR';
  const fetchedAt = new Date().toISOString();
  const insights = {
    avgDurationMin: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    minDurationMin: durations.length ? Math.min(...durations) : null,
    directAvailable: stopCounts.some((s) => s === 0),
    allDirect: stopCounts.length > 0 && stopCounts.every((s) => s === 0),
    airlines: [],
  };
  const snapshot = buildPriceSnapshot({ price: cheapest.price, currency, checkedAt: fetchedAt, source: 'live', offersCount: offers.length });
  await setAdminConfig(cacheKey, {
    price: cheapest.price,
    currency,
    departure_date,
    insights,
    offers: { cheapest },
    offersCount: offers.length,
    fetchedAt,
  });
  return { ok: true, price: cheapest.price, currency, departure_date, insights, offers: { cheapest }, cached: false, checkedAt: fetchedAt, offersCount: offers.length, snapshot };
}

async function cachedLivePrice(cacheKey) {
  const cached = await getAdminConfig(cacheKey, null);
  if (!cached) return null;
  const isFresh = cached.fetchedAt
    && Number.isFinite(new Date(cached.fetchedAt).getTime())
    && Date.now() - new Date(cached.fetchedAt).getTime() < PRICE_FRESHNESS_MS;
  return {
    ok: true,
    price: cached.price,
    currency: cached.currency,
    departure_date: cached.departure_date,
    insights: cached.insights || null,
    offers: cached.offers || null,
    cached: true,
    stale: !isFresh,
    checkedAt: cached.fetchedAt,
    offersCount: cached.offersCount ?? null,
    snapshot: buildPriceSnapshot({ price: cached.price, currency: cached.currency, checkedAt: cached.fetchedAt, source: isFresh ? 'cache' : 'stale-cache', offersCount: cached.offersCount }),
  };
}

async function handle(req, res, next) {
  if (!isRealBrowser(req)) return next();
  const from = String(req.query.from || '').toUpperCase();
  const to = String(req.query.to || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) return next();
  if (!(await isPublishedRoute(from, to))) return next();

  const daysAhead = req.query.days_ahead ? Math.max(1, Math.min(90, parseInt(req.query.days_ahead, 10) || 21)) : 21;
  const cacheKey = 'route_price_' + from + '_' + to + (daysAhead !== 21 ? '_d' + daysAhead : '');
  const pairKey = from + '_' + to + '_' + daysAhead;

  const cached = await cachedLivePrice(cacheKey).catch(() => null);
  const cachedTime = cached?.checkedAt ? new Date(cached.checkedAt).getTime() : NaN;
  const fresh = cached && Number.isFinite(cachedTime) && Date.now() - cachedTime < PRICE_FRESHNESS_MS;
  if (fresh) {
    logSearchAccess({ endpoint: '/route-price', source: 'route_price_user_visit', ip: clientIp(req), route: from + '-' + to, allowed: true, reason: 'fresh_24h_cache' });
    return res.json(cached);
  }

  let pending = inFlight.get(pairKey);
  if (!pending) {
    pending = fetchLiveRoutePrice(from, to, daysAhead, cacheKey).finally(() => inFlight.delete(pairKey));
    inFlight.set(pairKey, pending);
  }

  try {
    const result = await pending;
    logSearchAccess({ endpoint: '/route-price', source: 'route_price_user_visit', ip: clientIp(req), route: from + '-' + to, allowed: true, reason: 'live_user_visit_after_expiry' });
    return res.json(result);
  } catch (err) {
    if (cached) return res.json(cached);
    logSearchAccess({ endpoint: '/route-price', source: 'route_price_user_visit', ip: clientIp(req), route: from + '-' + to, allowed: false, reason: 'live_price_failed' });
    return res.json({ ok: true, price: null, currency: null, departure_date: null, snapshot: buildPriceSnapshot({ source: 'none' }) });
  }
}

module.exports = (app) => {
  app.get('/route-price', rateLimit('route-price-live', 30, 60000), handle);
};

module.exports.handle = handle;
module.exports.isRealBrowser = isRealBrowser;
module.exports.fetchLiveRoutePrice = fetchLiveRoutePrice;
