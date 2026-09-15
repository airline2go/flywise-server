const rateLimit = require('./rateLimit');
const { clientIp, logSearchAccess } = require('./searchGuard');
const {
  fetchAndCacheRoutePrice,
  isPublishedRoute,
} = require('../routes/search.routes');
const { getAdminConfig } = require('../services/adminConfig');
const { PRICE_FRESHNESS_MS, buildPriceSnapshot } = require('../config/price');

const BOT_UA = /bot|crawler|spider|slurp|bingpreview|google-extended|googleother|adsbot|mediapartners-google|facebookexternalhit|facebot|twitterbot|linkedinbot|slackbot|discordbot|telegrambot|whatsapp|gptbot|chatgpt-user|oai-searchbot|anthropic|claude|perplexity|semrush|ahrefs|petalbot|bytespider|yandex|baiduspider|duckduckbot|applebot|curl|wget|python-requests|python-httpx|node-fetch|axios|okhttp|headlesschrome|puppeteer|playwright|lighthouse|pagespeed|pingdom|uptimerobot|statuscake/i;

function isLikelyBot(req) {
  const ua = String(req.get('user-agent') || '');
  if (!ua) return true;
  if (BOT_UA.test(ua)) return true;

  // A route-price refresh is allowed only when it comes from a real browser
  // fetch/navigation context. Do not treat a generic JSON client (curl,
  // scripts, server-to-server callers, etc.) as a human visit merely because
  // it sends Accept: application/json. This is the hard gate before Duffel.
  const fetchMode = String(req.get('sec-fetch-mode') || '').toLowerCase();
  const fetchDest = String(req.get('sec-fetch-dest') || '').toLowerCase();
  const browserFetch = fetchMode === 'cors' || fetchMode === 'same-origin' || fetchDest === 'empty';
  return !browserFetch;
}

const inFlight = new Map();

async function getCachedRouteResponse(cacheKey) {
  const cached = await getAdminConfig(cacheKey, null);
  if (!cached) return null;
  const stale = cached.fetchedAt
    ? Date.now() - new Date(cached.fetchedAt).getTime() >= PRICE_FRESHNESS_MS
    : false;
  return {
    ok: true,
    price: cached.price,
    currency: cached.currency,
    departure_date: cached.departure_date,
    insights: cached.insights || null,
    offers: cached.offers || null,
    cached: true,
    stale: stale || undefined,
    checksToday: null,
    checkedAt: cached.fetchedAt,
    offersCount: cached.offersCount ?? null,
    snapshot: buildPriceSnapshot({
      price: cached.price,
      currency: cached.currency,
      checkedAt: cached.fetchedAt,
      source: stale ? 'stale-cache' : 'cache',
      offersCount: cached.offersCount,
    }),
  };
}

async function handleRoutePriceVisit(req, res, next) {
  try {
    if (isLikelyBot(req)) return next();

    const { from, to } = req.query;
    if (!from || !to) return next();
    const origin = String(from).toUpperCase();
    const dest = String(to).toUpperCase();
    if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(dest)) return next();

    const allowed = await isPublishedRoute(origin, dest);
    if (!allowed) return next();

    const daysAhead = req.query.days_ahead
      ? Math.max(1, Math.min(90, parseInt(req.query.days_ahead, 10) || 21))
      : 21;
    const cacheKey = 'route_price_' + origin + '_' + dest + (daysAhead !== 21 ? '_d' + daysAhead : '');
    const pairKey = origin + '_' + dest + '_' + daysAhead;

    let refresh = inFlight.get(pairKey);
    if (!refresh) {
      refresh = fetchAndCacheRoutePrice(origin, dest, daysAhead, cacheKey)
        .finally(() => inFlight.delete(pairKey));
      inFlight.set(pairKey, refresh);
    }

    const result = await refresh;
    logSearchAccess({
      endpoint: '/route-price', source: 'route_price_user_visit', ip: clientIp(req),
      route: origin + '-' + dest, allowed: true, reason: 'live_user_visit',
    });
    return res.json(result);
  } catch (err) {
    const from = req.query.from ? String(req.query.from).toUpperCase() : '';
    const to = req.query.to ? String(req.query.to).toUpperCase() : '';
    const daysAhead = req.query.days_ahead
      ? Math.max(1, Math.min(90, parseInt(req.query.days_ahead, 10) || 21))
      : 21;
    const cacheKey = from && to
      ? 'route_price_' + from + '_' + to + (daysAhead !== 21 ? '_d' + daysAhead : '')
      : null;
    if (cacheKey) {
      try {
        const cached = await getCachedRouteResponse(cacheKey);
        if (cached) return res.json(cached);
      } catch (_) { /* fall through */ }
    }
    return next();
  }
}

module.exports = (app) => {
  app.get('/route-price', rateLimit('route-price-live', 30, 60000), handleRoutePriceVisit);
};

module.exports.isLikelyBot = isLikelyBot;
module.exports.handleRoutePriceVisit = handleRoutePriceVisit;
