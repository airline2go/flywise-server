const {
  getRouteIndexabilityDecision,
  hasRouteDemandSignal,
  hasFreshRouteData,
  routeDataMaxAgeMs,
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
  insights_updated_at: new Date().toISOString(),
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

  test('when ON, stale route evidence is pruned even with demand', () => {
    withGate('1', () => {
      const stale = { ...EVIDENCE, route_score: 5, insights_updated_at: '2026-01-01T00:00:00.000Z' };
      const d = getRouteIndexabilityDecision(stale);
      expect(d.indexable).toBe(false);
      expect(d.reason).toBe('STALE ROUTE DATA (pruned)');
      expect(d.routeDataFresh).toBe(false);
    });
  });

  test('when ON, fresh route evidence plus demand stays indexable', () => {
    withGate('1', () => {
      const d = getRouteIndexabilityDecision({ ...EVIDENCE, route_score: 1.5 });
      expect(d.indexable).toBe(true);
      expect(d.routeDataFresh).toBe(true);
    });
  });

  test('when ON, manual editorial content bypasses route-data freshness', () => {
    withGate('1', () => {
      const d = getRouteIndexabilityDecision({ intro_text: 'Hand-written guide.', insights_updated_at: '2026-01-01T00:00:00.000Z' });
      expect(d.indexable).toBe(true);
      expect(d.reason).toBe('MANUAL EDITORIAL CONTENT');
    });
  });

  test('freshness accepts the configured default and rejects future/missing timestamps', () => {
    const now = Date.parse('2026-09-17T00:00:00.000Z');
    expect(routeDataMaxAgeMs()).toBe(30 * 24 * 60 * 60 * 1000);
    expect(hasFreshRouteData({ insights_updated_at: '2026-09-01T00:00:00.000Z' }, now)).toBe(true);
    expect(hasFreshRouteData({ insights_updated_at: '2026-07-01T00:00:00.000Z' }, now)).toBe(false);
    expect(hasFreshRouteData({ insights_updated_at: '2026-09-18T00:00:00.000Z' }, now)).toBe(false);
    expect(hasFreshRouteData({}, now)).toBe(false);
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

  test('connectivity excludes demand-pruned and stale routes so hubs never link to noindex', () => {
    const routes = [
      { origin_city_slug: 'a', destination_city_slug: 'b', origin_iata: 'AAA', destination_iata: 'BBB', ...EVIDENCE, route_score: 5 },
      { origin_city_slug: 'a', destination_city_slug: 'c', origin_iata: 'AAA', destination_iata: 'CCC', ...EVIDENCE },
      { origin_city_slug: 'a', destination_city_slug: 'd', origin_iata: 'AAA', destination_iata: 'DDD', ...EVIDENCE, route_score: 5, insights_updated_at: '2026-01-01T00:00:00.000Z' },
    ];
    const gated = buildConnectivity(routes, { demandGate: true });
    expect(gated.cityDest.get('a')).toEqual(new Set(['b'])); // c has no demand; d is stale
    const ungated = buildConnectivity(routes, { demandGate: false });
    expect(ungated.cityDest.get('a')).toEqual(new Set(['b', 'c', 'd']));
  });
});
