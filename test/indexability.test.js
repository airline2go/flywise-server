const { routeIndexable, cityIndexable, airportIndexable, countryIndexable, airlineIndexable, buildConnectivity, cityDestinationCount, airportDestinationCount, countryConnectivityScore, airlineRouteCounts, hasVerifiedFlightEvidence, hasManualEditorialContent, getRouteIndexabilityDecision } = require('../src/services/indexability');
const evidenceFixture = require('./fixtures/route-evidence-cases.json');

describe('hasVerifiedFlightEvidence (canonical policy)', () => {
  test('distance_km alone is NEVER evidence', () => expect(hasVerifiedFlightEvidence({ distance_km: 9438 })).toBe(false));
  test('airline_count alone is NEVER evidence', () => expect(hasVerifiedFlightEvidence({ airline_count: 2 })).toBe(false));
  test('duration, real stops, sampled prices, or itineraries are evidence', () => {
    expect(hasVerifiedFlightEvidence({ avg_duration_min: 125 })).toBe(true);
    expect(hasVerifiedFlightEvidence({ avg_duration_min: 0 })).toBe(false);
    expect(hasVerifiedFlightEvidence({ stop_distribution: { '0': 3 } })).toBe(true);
    expect(hasVerifiedFlightEvidence({ stop_distribution: {} })).toBe(false);
    expect(hasVerifiedFlightEvidence({ price_sample_count: 12 })).toBe(true);
    expect(hasVerifiedFlightEvidence({ itinerary_count: 5 })).toBe(true);
  });
});

describe('getRouteIndexabilityDecision — enforced vs legacy (shared fixture)', () => {
  for (const c of evidenceFixture.cases) {
    test(`enforced: ${c.name} → ${c.enforced}`, () => expect(getRouteIndexabilityDecision(c.route, { enforce: true }).indexable).toBe(c.enforced));
    test(`legacy: ${c.name} → ${c.legacy}`, () => expect(getRouteIndexabilityDecision(c.route, { enforce: false }).indexable).toBe(c.legacy));
  }
  test('default policy is strict and fail-closed', () => {
    delete process.env.SEO_EVIDENCE_POLICY_ENFORCED;
    expect(routeIndexable({ distance_km: 500 })).toBe(false);
  });
  test('reason strings explain the verdict', () => {
    expect(getRouteIndexabilityDecision({ distance_km: 500 }, { enforce: true }).reason).toBe('NO VERIFIED FLIGHT EVIDENCE');
    expect(getRouteIndexabilityDecision({ airline_count: 2 }, { enforce: true }).reason).toBe('NO VERIFIED FLIGHT EVIDENCE');
    expect(getRouteIndexabilityDecision({ intro_text: 'x' }, { enforce: true }).reason).toBe('MANUAL EDITORIAL CONTENT');
  });
});

describe('connectivity honours evidence policy', () => {
  const unverified = { origin_city_slug: 'a', destination_city_slug: 'b', origin_iata: 'AAA', destination_iata: 'BBB', origin_country: 'DE', destination_country: 'ZZ', distance_km: 1000 };
  const verified = { origin_city_slug: 'a', destination_city_slug: 'c', origin_iata: 'AAA', destination_iata: 'CCC', origin_country: 'DE', destination_country: 'DE', avg_duration_min: 120 };
  test('strict mode ignores unverified route', () => expect(cityDestinationCount(buildConnectivity([unverified], { enforce: true }), 'a')).toBe(0));
  test('strict mode counts verified route', () => expect(cityDestinationCount(buildConnectivity([verified], { enforce: true }), 'a')).toBe(1));
  test('legacy mode counts legacy route', () => expect(cityDestinationCount(buildConnectivity([unverified], { enforce: false }), 'a')).toBe(1));
});

describe('routeIndexable', () => {
  test('thin route is NOT indexable', () => {
    expect(routeIndexable({})).toBe(false);
    expect(routeIndexable({ airline_count: 0, stop_distribution: {} })).toBe(false);
    expect(routeIndexable({ custom_faq: [] })).toBe(false);
  });
  test('verified evidence makes it indexable; airline count/distance alone do not', () => {
    expect(routeIndexable({ distance_km: 500 })).toBe(false);
    expect(routeIndexable({ avg_duration_min: 90 })).toBe(true);
    expect(routeIndexable({ airline_count: 1 })).toBe(false);
    expect(routeIndexable({ airline_count: 1, avg_duration_min: 90 })).toBe(true);
    expect(routeIndexable({ stop_distribution: { '0': 3 } })).toBe(true);
  });
  test('admin content alone makes it indexable', () => {
    expect(routeIndexable({ intro_text: 'hello' })).toBe(true);
    expect(routeIndexable({ custom_faq: [{ q: 'a', a: 'b' }] })).toBe(true);
  });
});

describe('entity indexability', () => {
  test('cities/airports require >=2 destinations or editorial content', () => {
    expect(cityIndexable({}, 1)).toBe(false); expect(cityIndexable({}, 2)).toBe(true); expect(cityIndexable({ intro_text: 'x' }, 1)).toBe(true);
    expect(airportIndexable({}, 1)).toBe(false); expect(airportIndexable({}, 2)).toBe(true);
  });
  test('countries/airlines require >=2 connectivity/routes or editorial content', () => {
    expect(countryIndexable({}, 1)).toBe(false); expect(countryIndexable({}, 2)).toBe(true);
    expect(airlineIndexable({}, 1)).toBe(false); expect(airlineIndexable({}, 2)).toBe(true);
  });
});

describe('counts', () => {
  test('connectivity counts distinct destinations', () => {
    const c = buildConnectivity([
      { origin_city_slug: 'a', destination_city_slug: 'b', origin_iata: 'AAA', destination_iata: 'BBB', origin_country: 'DE', destination_country: 'FR', avg_duration_min: 100 },
      { origin_city_slug: 'a', destination_city_slug: 'c', origin_iata: 'AAA', destination_iata: 'CCC', origin_country: 'DE', destination_country: 'ES', avg_duration_min: 110 },
    ], { enforce: true });
    expect(cityDestinationCount(c, 'a')).toBe(2); expect(airportDestinationCount(c, 'AAA')).toBe(2); expect(countryConnectivityScore(c, 'DE')).toBe(2);
  });
  test('airlineRouteCounts counts unique published pairs', () => {
    const counts = airlineRouteCounts([{ airline_id: 1, route_origin_iata: 'AAA', route_destination_iata: 'BBB' }, { airline_id: 1, route_origin_iata: 'AAA', route_destination_iata: 'CCC' }, { airline_id: 1, route_origin_iata: 'AAA', route_destination_iata: 'BBB' }], [{ origin_iata: 'AAA', destination_iata: 'BBB' }, { origin_iata: 'AAA', destination_iata: 'CCC' }]);
    expect(counts.get(1)).toBe(2);
  });
});

test('hasManualEditorialContent detects intro and FAQ', () => {
  expect(hasManualEditorialContent({ intro_text: 'x' })).toBe(true);
  expect(hasManualEditorialContent({ custom_faq: [{ q: 'a', a: 'b' }] })).toBe(true);
  expect(hasManualEditorialContent({})).toBe(false);
});
