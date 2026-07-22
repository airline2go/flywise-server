// ═══════════════════════════════════════════════════════════════════════════
// src/services/seo/compose.js
// Composition core for programmatic route-page SEO.
//
// Philosophy: a page is not one template with names swapped. It is ASSEMBLED
// from independent content blocks, each of which (a) only renders when the
// route actually has the real data it describes, and (b) chooses its own
// wording, structure and emphasis from the route's data plus a per-route
// seeded RNG. Two routes with different data produce structurally different
// pages; two routes with identical data still diverge because the seed rotates
// angle, section order, headings and phrasing.
//
// This file is language-agnostic. Language packs (e.g. blocks.de.js) supply
// the actual sentences. It invents nothing: every number rendered comes from
// the route row.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Seeded PRNG (mulberry32) ───────────────────────────────────
// Deterministic per route → stable output for Google, varied across routes.
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
// Choose k weighted items without replacement (for section selection).
function weightedPick(rng, items, k) {
  const pool = items.map((it) => ({ ...it, r: Math.pow(rng(), 1 / Math.max(0.0001, it.weight)) }));
  pool.sort((x, y) => y.r - x.r);
  return pool.slice(0, k);
}

// ─── Derived facts (verifiable only) ────────────────────────────
function durationFromDistance(km) {
  return Math.max(45, Math.round(30 + (km / 800) * 60)); // minutes, approximate
}
function fmtHM(min) {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  if (h <= 0) return `${m} Min.`;
  return m === 0 ? `${h} Std.` : `${h} Std. ${m} Min.`;
}

// Bucketize price into budget/moderate/premium RELATIVE to haul type, so a
// "cheap long-haul" and a "cheap short-haul" are judged on different scales.
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
// Directness derived from the strongest available signal.
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
  if (conf === 'low') return null; // don't make popularity claims on weak data
  const s = Number(route.route_score);
  if (s >= 70) return 'high';
  if (s >= 40) return 'moderate';
  return 'niche';
}

// ═══════════════════════════════════════════════════════════════
// Context = the union of every real data dimension known about a route.
//
// It is built by an ENRICHER PIPELINE: an ordered list of small functions,
// each of which reads the route row (and optional joined `sources`) and adds
// the fields + `facts` flags it is responsible for. This is the extensibility
// backbone — a new data source (historical prices, airport guide, visa rules,
// baggage, transport, tourism, seasonality, demand…) is added as ONE enricher
// plus the block(s) that consume its facts. No existing code is rewritten.
//
// Contract for an enricher: (ctx, route, sources) => void
//   • only set a field when the data is REAL and present (never guess);
//   • call ctx.facts.add('<dimension>') for each dimension it makes available,
//     so blocks/angles can declare their data requirements against it.
// ═══════════════════════════════════════════════════════════════

// Core enricher: everything derivable from the route_pages row itself.
function coreEnricher(ctx, route) {
  const km = route.distance_km ? Math.round(route.distance_km) : null;
  const durMin = route.avg_duration_min || route.min_duration_min ||
    (km ? durationFromDistance(km) : null);
  const durationIsReal = !!(route.avg_duration_min || route.min_duration_min);

  Object.assign(ctx, {
    o: route.origin_city, d: route.destination_city,
    oIata: route.origin_iata, dIata: route.destination_iata,
    oCountry: route.origin_country, dCountry: route.destination_country,
    km, haul: route.haul_type,
    domestic: !!(route.origin_country && route.origin_country === route.destination_country),
    durMin, durationIsReal, fmtDur: durMin ? fmtHM(durMin) : null,
    minDurMin: route.min_duration_min || null,
    airlineCount: route.airline_count ?? null,
    itineraryCount: route.itinerary_count ?? null,
    priceMin: route.price_min != null ? Number(route.price_min) : null,
    priceMax: route.price_max != null ? Number(route.price_max) : null,
    priceAvg: route.price_avg != null ? Number(route.price_avg) : null,
    priceCurrency: route.price_currency || 'EUR',
    priceTrend: route.price_trend || null,
    priceSampleCount: route.price_sample_count ?? null,
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
  if (ctx.priceB) ctx.facts.add('price');
  if (ctx.priceTrend) ctx.facts.add('priceTrend');
  if (ctx.airlineB) ctx.facts.add('airlines');
  if (ctx.directB) ctx.facts.add('directness');
  if (ctx.popB) ctx.facts.add('popularity');
  if (ctx.itineraryCount) ctx.facts.add('itineraries');
}

// The pipeline. Core is always first; future enrichers append here (or via
// registerEnricher) and run in order. Kept module-level so the set of data
// sources is one obvious list.
const ENRICHERS = [coreEnricher];

// Register an additional enricher (e.g. from a future data-source module).
// Idempotent-friendly: callers should register once at require time.
function registerEnricher(fn) {
  if (typeof fn === 'function' && !ENRICHERS.includes(fn)) ENRICHERS.push(fn);
}

// Build the context by running every enricher. `sources` carries optional
// joined data the batch layer fetched (price history rows, airport guides,
// alternative-airport lists, …) — enrichers that need none simply ignore it.
function buildContext(route, sources = {}) {
  const ctx = {
    slug: route.slug || `${route.origin_iata}-${route.destination_iata}`,
    facts: new Set(),
    sources,
  };
  for (const enrich of ENRICHERS) enrich(ctx, route, sources);
  return ctx;
}

module.exports = {
  makeRng, pick, shuffle, weightedPick,
  buildContext, registerEnricher, ENRICHERS, coreEnricher,
  durationFromDistance, fmtHM,
  priceBucket, airlineBucket, directnessBucket, popularityBucket,
};
