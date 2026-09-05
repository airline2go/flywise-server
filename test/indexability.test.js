// Unit tests for the indexability rules — the single source of truth the
// sitemap generator relies on. These pin each rule to the exact frontend
// [THIN-CONTENT-NOINDEX] guard it mirrors, so a future drift is caught here.
const {
  routeIndexable, cityIndexable, airportIndexable, countryIndexable, airlineIndexable,
  buildConnectivity, cityDestinationCount, airportDestinationCount, countryConnectivityScore,
  airlineRouteCounts,
  hasVerifiedFlightEvidence, hasManualEditorialContent, getRouteIndexabilityDecision,
} = require('../src/services/indexability');
const evidenceFixture = require('./fixtures/route-evidence-cases.json');

describe('hasVerifiedFlightEvidence (canonical policy)', () => {
  test('distance_km alone is NEVER evidence', () => {
    expect(hasVerifiedFlightEvidence({ distance_km: 9438 })).toBe(false);
  });
  test('airline_count=0 is NEVER evidence', () => {
    expect(hasVerifiedFlightEvidence({ airline_count: 0, distance_km: 500 })).toBe(false);
  });
  test('airline_count>0 is evidence', () => {
    expect(hasVerifiedFlightEvidence({ airline_count: 1 })).toBe(true);
  });
  test('valid duration is evidence; zero duration is not', () => {
    expect(hasVerifiedFlightEvidence({ avg_duration_min: 125 })).toBe(true);
    expect(hasVerifiedFlightEvidence({ avg_duration_min: 0 })).toBe(false);
  });
  test('real stop_distribution is evidence; empty is not', () => {
    expect(hasVerifiedFlightEvidence({ stop_distribution: { '0': 3 } })).toBe(true);
    expect(hasVerifiedFlightEvidence({ stop_distribution: {} })).toBe(false);
  });
  test('price_sample_count>0 and itinerary_count>0 are evidence', () => {
    expect(hasVerifiedFlightEvidence({ price_sample_count: 12 })).toBe(true);
    expect(hasVerifiedFlightEvidence({ itinerary_count: 5 })).toBe(true);
    expect(hasVerifiedFlightEvidence({ price_sample_count: 0, itinerary_count: 0 })).toBe(false);
  });
});

describe('getRouteIndexabilityDecision — enforced vs legacy (shared fixture)', () => {
  for (const c of evidenceFixture.cases) {
    test(`enforced: ${c.name} → ${c.enforced}`, () => {
      expect(getRouteIndexabilityDecision(c.route, { enforce: true }).indexable).toBe(c.enforced);
    });
    test(`legacy: ${c.name} → ${c.legacy}`, () => {
      expect(getRouteIndexabilityDecision(c.route, { enforce: false }).indexable).toBe(c.legacy);
    });
  }
  test('default (flag off) preserves legacy behaviour — no accidental flip', () => {
    delete process.env.SEO_EVIDENCE_POLICY_ENFORCED;
    expect(routeIndexable({ distance_km: 500 })).toBe(true); // distance-only stays indexable
  });
  test('reason strings explain the verdict', () => {
    expect(getRouteIndexabilityDecision({ distance_km: 500 }, { enforce: true }).reason).toBe('NO VERIFIED FLIGHT EVIDENCE');
    expect(getRouteIndexabilityDecision({ airline_count: 2 }, { enforce: true }).reason).toBe('VERIFIED FLIGHT EVIDENCE');
    expect(getRouteIndexabilityDecision({ intro_text: 'x' }, { enforce: true }).reason).toBe('MANUAL EDITORIAL CONTENT');
  });
});

describe('P0-2 connectivity honours evidence policy when enforced', () => {
  const berlinX = { origin_iata: 'BER', destination_iata: 'XXX', origin_city_slug: 'berlin', destination_city_slug: 'nowhere', origin_country: 'DE', destination_country: 'ZZ', airline_count: 0 };
  const verified = { origin_iata: 'BER', destination_iata: 'MUC', origin_city_slug: 'berlin', destination_city_slug: 'muenchen', origin_country: 'DE', destination_country: 'DE', airline_count: 3 };
  test('zero-flight route does NOT raise connectivity when enforced', () => {
    const c = buildConnectivity([berlinX], { enforce: true });
    expect(cityDestinationCount(c, 'berlin')).toBe(0);
  });
  test('verified route DOES raise connectivity when enforced', () => {
    const c = buildConnectivity([verified], { enforce: true });
    expect(cityDestinationCount(c, 'berlin')).toBe(1);
  });
  test('legacy (flag off) still counts zero-flight route', () => {
    const c = buildConnectivity([berlinX], { enforce: false });
    expect(cityDestinationCount(c, 'berlin')).toBe(1);
  });
});

describe('routeIndexable', () => {
  test('thin route (no data, no admin content) is NOT indexable', () => {
    expect(routeIndexable({})).toBe(false);
    expect(routeIndexable({ airline_count: 0, stop_distribution: {} })).toBe(false);
    expect(routeIndexable({ custom_faq: [] })).toBe(false);
  });
  test('any single real data point makes it indexable', () => {
    expect(routeIndexable({ distance_km: 500 })).toBe(true);
    expect(routeIndexable({ avg_duration_min: 90 })).toBe(true);
    expect(routeIndexable({ airline_count: 1 })).toBe(true);
    expect(routeIndexable({ stop_distribution: { '0': 3 } })).toBe(true);
  });
  test('admin content alone makes it indexable', () => {
    expect(routeIndexable({ intro_text: 'hello' })).toBe(true);
    expect(routeIndexable({ custom_faq: [{ q: 'a', a: 'b' }] })).toBe(true);
  });
});

describe('cityIndexable', () => {
  test('<=1 distinct destination and no intro is thin', () => {
    expect(cityIndexable({}, 0)).toBe(false);
    expect(cityIndexable({}, 1)).toBe(false);
  });
  test('>=2 distinct destinations OR intro_text is indexable', () => {
    expect(cityIndexable({}, 2)).toBe(true);
    expect(cityIndexable({ intro_text: 'x' }, 1)).toBe(true);
  });
});

describe('airportIndexable', () => {
  test('<=1 distinct destination with no admin content is thin', () => {
    expect(airportIndexable({}, 1)).toBe(false);
  });
  test('>=2 destinations OR any admin content is indexable', () => {
    expect(airportIndexable({}, 2)).toBe(true);
    expect(airportIndexable({ terminal_info: 'x' }, 0)).toBe(true);
    expect(airportIndexable({ transit_options: 'x' }, 0)).toBe(true);
    expect(airportIndexable({ traveler_tips: 'x' }, 1)).toBe(true);
  });
});

describe('countryIndexable', () => {
  test('score <=1 and no intro is thin; score >=2 or intro indexable', () => {
    expect(countryIndexable({}, 1)).toBe(false);
    expect(countryIndexable({}, 2)).toBe(true);
    expect(countryIndexable({ intro_text: 'x' }, 0)).toBe(true);
  });
});

describe('airlineIndexable', () => {
  test('<=1 route and no intro is thin; >=2 routes or intro indexable', () => {
    expect(airlineIndexable({}, 1)).toBe(false);
    expect(airlineIndexable({}, 2)).toBe(true);
    expect(airlineIndexable({ intro_text: 'x' }, 0)).toBe(true);
  });
});

describe('buildConnectivity', () => {
  const routes = [
    // Berlin reaches Munich and Paris (2 distinct) → indexable city.
    { origin_iata: 'BER', destination_iata: 'MUC', origin_city_slug: 'berlin', destination_city_slug: 'muenchen', origin_country: 'DE', destination_country: 'DE' },
    { origin_iata: 'BER', destination_iata: 'CDG', origin_city_slug: 'berlin', destination_city_slug: 'paris', origin_country: 'DE', destination_country: 'FR' },
    // Reverse direction of an existing pair collapses (still 2 for Berlin).
    { origin_iata: 'MUC', destination_iata: 'BER', origin_city_slug: 'muenchen', destination_city_slug: 'berlin', origin_country: 'DE', destination_country: 'DE' },
    // Lonely city: Cologne only reaches Munich (1 distinct) → thin.
    { origin_iata: 'CGN', destination_iata: 'MUC', origin_city_slug: 'koeln', destination_city_slug: 'muenchen', origin_country: 'DE', destination_country: 'DE' },
  ];
  const c = buildConnectivity(routes);

  test('city distinct-destination counts collapse both directions', () => {
    expect(cityDestinationCount(c, 'berlin')).toBe(2); // muenchen + paris
    expect(cityDestinationCount(c, 'koeln')).toBe(1);  // muenchen only
  });

  test('airport distinct-destination counts key on the other end city', () => {
    expect(airportDestinationCount(c, 'BER')).toBe(2); // muenchen + paris
    expect(airportDestinationCount(c, 'CGN')).toBe(1);
  });

  test('country score = distinct external destinations + domestic route count', () => {
    // DE domestic routes: BER-MUC, MUC-BER, CGN-MUC = 3 domestic.
    // DE external destinations: paris (1 distinct). Score = 1 + 3 = 4.
    expect(countryConnectivityScore(c, 'DE')).toBe(4);
    // FR: one external destination (berlin), no domestic. Score = 1.
    expect(countryConnectivityScore(c, 'FR')).toBe(1);
  });

  test('missing other-end slug is skipped, not counted as a destination', () => {
    const c2 = buildConnectivity([
      { origin_iata: 'AAA', destination_iata: 'BBB', origin_city_slug: 'aa', destination_city_slug: null, origin_country: 'XX', destination_country: 'YY' },
    ]);
    expect(cityDestinationCount(c2, 'aa')).toBe(0);
  });
});

describe('airlineRouteCounts', () => {
  const published = [
    { origin_iata: 'BER', destination_iata: 'MUC' },
    { origin_iata: 'BER', destination_iata: 'CDG' },
    { origin_iata: 'HAM', destination_iata: 'MUC' },
  ];
  test('counts only distinct PUBLISHED pairs, capped at 2', () => {
    const observed = [
      { airline_id: 1, route_origin_iata: 'BER', route_destination_iata: 'MUC' },
      { airline_id: 1, route_origin_iata: 'BER', route_destination_iata: 'CDG' },
      { airline_id: 1, route_origin_iata: 'BER', route_destination_iata: 'CDG' }, // dup
      { airline_id: 2, route_origin_iata: 'BER', route_destination_iata: 'MUC' },
      { airline_id: 2, route_origin_iata: 'ZZZ', route_destination_iata: 'YYY' }, // not published
    ];
    const counts = airlineRouteCounts(observed, published);
    expect(counts.get(1)).toBe(2); // BER-MUC, BER-CDG
    expect(counts.get(2)).toBe(1); // only BER-MUC published
  });
});
