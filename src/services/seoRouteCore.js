// [SEO-CORE-50]
// Recovery cohort for the current SEO rehabilitation phase.
//
// These are existing, published route pages selected from the live catalogue
// using fresh operational evidence, observed itineraries, carrier breadth,
// price samples and content completeness, with one direction per city-pair.
// No rows are created here and no database schema changes are required.
//
// Expand this set in controlled batches (10–20 routes) only after the current
// cohort remains healthy. The set is intentionally versioned in git so the
// indexable surface does not drift with volatile scoring data.

const SEO_CORE_ROUTES = new Set([
  'london-athens',
  'madrid-zuerich',
  'hamburg-barcelona-2',
  'duesseldorf-palma-de-mallorca',
  'ber-bud',
  'lgw-pmi',
  'ibiza-frankfurt',
  'las-palmas-hamburg',
  'paris-zuerich',
  'lisbon-barcelona',
  'stockholm-paris',
  'stockholm-frankfurt',
  'barcelona-dublin',
  'ber-jfk',
  'barcelona-frankfurt',
  'berlin-athens',
  'berlin-barcelona',
  'berlin-amsterdam',
  'berlin-rome',
  'berlin-lisbon',
  'zuerich-amsterdam',
  'madrid-berlin',
  'berlin-istanbul',
  'barcelona-zuerich',
  'palma-de-mallorca-hamburg',
  'barcelona-amsterdam',
  'malaga-paris',
  'copenhagen-berlin',
  'istanbul-london',
  'frankfurt-zuerich',
  'paris-copenhagen',
  'zuerich-rome',
  'zuerich-lisbon',
  'auh-ath',
  'auh-ber',
  'zuerich-istanbul',
  'ber-ord',
  'palma-de-mallorca-malaga',
  'london-zuerich',
  'barcelona-madrid',
  'alicante-berlin',
  'muc-gva',
  'malaga-munich',
  'barcelona-paris',
  'stockholm-zuerich',
  'london-amsterdam',
  'frankfurt-berlin',
  'tenerife-berlin',
  'auh-prg',
]);

const SEO_CORE_ROUTE_COUNT = SEO_CORE_ROUTES.size;

function seoCoreOnlyEnabled() {
  // Recovery mode is deliberately ON by default. Operators can roll it back
  // instantly with SEO_ROUTE_CORE_ONLY=0 without changing code or DB state.
  if (process.env.SEO_ROUTE_CORE_ONLY == null) return true;
  return process.env.SEO_ROUTE_CORE_ONLY === '1' || process.env.SEO_ROUTE_CORE_ONLY === 'true';
}

function isSeoCoreRoute(slug) {
  return typeof slug === 'string' && SEO_CORE_ROUTES.has(slug);
}

module.exports = {
  SEO_CORE_ROUTES,
  SEO_CORE_ROUTE_COUNT,
  seoCoreOnlyEnabled,
  isSeoCoreRoute,
};
