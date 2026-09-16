// ═══════════════════════════════════════════════════════════════════════════
// src/services/seo/compose.js
// Composition core for programmatic route-page SEO.
// ═══════════════════════════════════════════════════════════════════════════

function makeRng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function shuffle(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function weightedPick(rng, items, k) {
  const pool = items.map((it) => ({ ...it, r: Math.pow(rng(), 1 / Math.max(0.0001, it.weight)) }));
  pool.sort((x, y) => y.r - x.r);
  return pool.slice(0, k);
}

function fmtHM(min) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  if (h <= 0) return `${m} Min.`;
  return m === 0 ? `${h} Std.` : `${h} Std. ${m} Min.`;
}

function validCurrency(value) {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value.trim().toUpperCase())
    ? value.trim().toUpperCase()
    : null;
}

function validPositivePrice(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function priceBucket(priceMin, haul) {
  if (priceMin == null) return null;
  const thresholds = {
    'short-haul': [60, 130],
    'medium-haul': [110, 240],
    'long-haul': [350, 700],
  }[haul] || [100, 250];
  if (priceMin < thresholds[0]) return 'budget';
  if (priceMin < thresholds[1]) return 'moderate';
  return 'premium';
}
function airlineBucket(n) {
  if (n == null) return null;
  if (n <= 1) return 'single';
  if (n <= 3) return 'few';
  if (n <= 6) return 'several';
  return 'many';
}
function directnessBucket(route) {
  if (route.all_direct === true) return 'all-direct';
  const sd = route.stop_distribution;
  if (sd && typeof sd === 'object') {
    const direct = Number(sd['0'] || 0);
    const total = Object.values(sd).reduce((a, b) => a + Number(b || 0), 0);
    if (total > 0) {
      const share = direct / total;
      if (share >= 0.99) return 'all-direct';
      if (share <= 0.01) return 'connections-only';
      if (share >= 0.5) return 'mostly-direct';
      return 'mixed';
    }
  }
  if (route.direct_flight_available === true) return 'has-direct';
  if (route.direct_flight_available === false) return 'connections-only';
  return null;
}
function popularityBucket(route) {
  if (route.route_score == null) return null;
  const conf = route.route_score_confidence;
  if (conf === 'low') return null;
  const s = Number(route.route_score);
  if (!Number.isFinite(s)) return null;
  if (s >= 70) return 'high';
  if (s >= 40) return 'moderate';
  return 'niche';
}

function coreEnricher(ctx, route) {
  const km = Number.isFinite(Number(route.distance_km)) && Number(route.distance_km) > 0
    ? Math.round(Number(route.distance_km))
    : null;
  const durMin = Number(route.avg_duration_min) > 0
    ? Number(route.avg_duration_min)
    : (Number(route.min_duration_min) > 0 ? Number(route.min_duration_min) : null);
  const durationIsReal = durMin != null;

  const priceCurrency = validCurrency(route.price_currency);
  const rawPriceMin = validPositivePrice(route.price_min);
  const rawPriceMax = validPositivePrice(route.price_max);
  const rawPriceAvg = validPositivePrice(route.price_avg);
  const hasPriceEvidence = !!(priceCurrency && (rawPriceMin != null || rawPriceAvg != null || rawPriceMax != null));

  Object.assign(ctx, {
    o: route.origin_city, d: route.destination_city,
    oIata: route.origin_iata, dIata: route.destination_iata,
    oCountry: route.origin_country, dCountry: route.destination_country,
    km, haul: route.haul_type,
    domestic: !!(route.origin_country && route.origin_country === route.destination_country),
    durMin, durationIsReal, fmtDur: durMin ? fmtHM(durMin) : null,
    minDurMin: Number(route.min_duration_min) > 0 ? Number(route.min_duration_min) : null,
    airlineCount: Number(route.airline_count) > 0 ? Number(route.airline_count) : null,
    itineraryCount: Number(route.itinerary_count) > 0 ? Number(route.itinerary_count) : null,
    priceMin: hasPriceEvidence ? rawPriceMin : null,
    priceMax: hasPriceEvidence ? rawPriceMax : null,
    priceAvg: hasPriceEvidence ? rawPriceAvg : null,
    priceCurrency: hasPriceEvidence ? priceCurrency : null,
    priceTrend: route.price_trend || null,
    priceSampleCount: Number(route.price_sample_count) > 0 ? Number(route.price_sample_count) : null,
    routeScore: route.route_score != null ? Number(route.route_score) : null,
    scoreConfidence: route.route_score_confidence || null,
    stopDistribution: route.stop_distribution || null,
  });

  ctx.priceB = priceBucket(ctx.priceMin, ctx.haul);
  ctx.airlineB = airlineBucket(ctx.airlineCount);
  ctx.directB = directnessBucket(route);
  ctx.popB = popularityBucket(route);

  if (ctx.km) ctx.facts.add('distance');
  if (ctx.durationIsReal) ctx.facts.add('duration');
  if (ctx.priceB && ctx.priceCurrency) ctx.facts.add('price');
  if (ctx.priceTrend && ctx.facts.has('price')) ctx.facts.add('priceTrend');
  if (ctx.airlineB) ctx.facts.add('airlines');
  if (ctx.directB) ctx.facts.add('directness');
  if (ctx.popB) ctx.facts.add('popularity');
  if (ctx.itineraryCount) ctx.facts.add('itineraries');
}

const ENRICHERS = [coreEnricher];
function registerEnricher(fn) {
  if (typeof fn === 'function' && !ENRICHERS.includes(fn)) ENRICHERS.push(fn);
}
function buildContext(route, sources = {}) {
  const ctx = { slug: route.slug || `${route.origin_iata}-${route.destination_iata}`, facts: new Set(), sources };
  for (const enrich of ENRICHERS) enrich(ctx, route, sources);
  return ctx;
}

module.exports = {
  makeRng, pick, shuffle, weightedPick,
  buildContext, registerEnricher, ENRICHERS, coreEnricher,
  fmtHM, validCurrency, validPositivePrice,
  priceBucket, airlineBucket, directnessBucket, popularityBucket,
};
