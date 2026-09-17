const {
  getRouteIndexabilityDecision,
  hasRouteDemandSignal,
  routeMinScore,
  buildConnectivity,
} = require('../src/services/indexability');

// [SEO-ROUTE-DEMAND-GATE] The strong-prune gate keeps out evidence-passing but
// no-demand templated route pages. It is opt-in via SEO_ROUTE_DEMAND_GATE and
// must never remove a manual-editorial route or change legacy (non-enforced)
// behaviour. A route with full flight evidence is the baseline fixture here.
const EVIDENCE = Object.freeze({
  avg_duration_min: 120,
  stop_distribution: { 0: 3, 1: 1 },
  price_sample_count: 5,
  itinerary_count: 8,
});

function withGate(value, fn) {
  const prev = process.env.SEO_ROUTE_DEMAND_GATE;
  if (value == null) delete process.env.SEO_ROUTE_DEMAND_GATE;
  else process.env.SEO_ROUTE_DEMAND_GATE = value;
  try { return fn(); } finally {
    if (prev == null) delete process.env.SEO_ROUTE_DEMAND_GATE;
    else process.env.SEO_ROUTE_DEMAND_GATE = prev;
  }
}

describe('route demand gate', () => {
  test('is OFF by default: evidence-only routes stay indexable', () => {
    withGate(undefined, () => {
      expect(getRouteIndexabilityDecision(EVIDENCE).indexable).toBe(true);
    });
  });

  test('when ON, an evidence-only route with no demand is pruned to noindex', () => {
    withGate('1', () => {
      const d = getRouteIndexabilityDecision(EVIDENCE);
      expect(d.indexable).toBe(false);
      expect(d.reason).toBe('NO DEMAND SIGNAL (pruned)');
      expect(d.verifiedEvidence).toBe(true);
    });
  });

  test('when ON, a route with a real popularity score stays indexable', () => {
    withGate('1', () => {
      expect(getRouteIndexabilityDecision({ ...EVIDENCE, route_score: 1.5 }).indexable).toBe(true);
    });
  });

  test('when ON, scheduled weekly flights keep a route indexable', () => {
    withGate('1', () => {
      expect(getRouteIndexabilityDecision({ ...EVIDENCE, weekly_flights: 7 }).indexable).toBe(true);
    });
  });

  test('when ON, manual editorial content is never pruned', () => {
    withGate('1', () => {
      expect(getRouteIndexabilityDecision({ intro_text: 'Hand-written guide.' }).indexable).toBe(true);
    });
  });

  test('a below-threshold score is not demand', () => {
    withGate('1', () => {
      // default threshold is 0.2
      expect(hasRouteDemandSignal({ route_score: 0.1 })).toBe(false);
      expect(hasRouteDemandSignal({ route_score: 0.2 })).toBe(true);
    });
  });

  test('SEO_ROUTE_MIN_SCORE tunes the threshold', () => {
    const prev = process.env.SEO_ROUTE_MIN_SCORE;
    process.env.SEO_ROUTE_MIN_SCORE = '1';
    try {
      expect(routeMinScore()).toBe(1);
      expect(hasRouteDemandSignal({ route_score: 0.5 })).toBe(false);
      expect(hasRouteDemandSignal({ route_score: 1 })).toBe(true);
    } finally {
      if (prev == null) delete process.env.SEO_ROUTE_MIN_SCORE; else process.env.SEO_ROUTE_MIN_SCORE = prev;
    }
  });

  test('explicit demandGate opt overrides the env for testability', () => {
    expect(getRouteIndexabilityDecision(EVIDENCE, { demandGate: true }).indexable).toBe(false);
    expect(getRouteIndexabilityDecision(EVIDENCE, { demandGate: false }).indexable).toBe(true);
  });

  test('the demand gate never applies in legacy (non-enforced) mode', () => {
    expect(getRouteIndexabilityDecision({ distance_km: 1000 }, { enforce: false, demandGate: true }).indexable).toBe(true);
  });

  test('connectivity excludes demand-pruned routes so hubs never link to noindex', () => {
    const routes = [
      { origin_city_slug: 'a', destination_city_slug: 'b', origin_iata: 'AAA', destination_iata: 'BBB', ...EVIDENCE, route_score: 5 },
      { origin_city_slug: 'a', destination_city_slug: 'c', origin_iata: 'AAA', destination_iata: 'CCC', ...EVIDENCE },
    ];
    const gated = buildConnectivity(routes, { demandGate: true });
    expect(gated.cityDest.get('a')).toEqual(new Set(['b'])); // c is pruned (no demand)
    const ungated = buildConnectivity(routes, { demandGate: false });
    expect(ungated.cityDest.get('a')).toEqual(new Set(['b', 'c']));
  });
});
