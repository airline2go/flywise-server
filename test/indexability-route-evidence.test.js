const {
  hasVerifiedFlightEvidence,
  getRouteIndexabilityDecision,
  buildConnectivity,
} = require('../src/services/indexability');

describe('route evidence policy', () => {
  test('strict evidence is enabled by default', () => {
    const previous = process.env.SEO_EVIDENCE_POLICY_ENFORCED;
    delete process.env.SEO_EVIDENCE_POLICY_ENFORCED;
    expect(getRouteIndexabilityDecision({ distance_km: 1200 }).indexable).toBe(false);
    if (previous == null) delete process.env.SEO_EVIDENCE_POLICY_ENFORCED;
    else process.env.SEO_EVIDENCE_POLICY_ENFORCED = previous;
  });

  test('invalid fractional airline count is not flight evidence', () => {
    expect(hasVerifiedFlightEvidence({ airline_count: 1.5 })).toBe(false);
    expect(hasVerifiedFlightEvidence({ airline_count: 2 })).toBe(true);
  });

  test('malformed stop distribution is not flight evidence', () => {
    expect(hasVerifiedFlightEvidence({ stop_distribution: { '0': 3, '1': -1 } })).toBe(false);
    expect(hasVerifiedFlightEvidence({ stop_distribution: { '0': 3, '1': 1 } })).toBe(true);
  });

  test('distance-only routes do not inflate connectivity under strict policy', () => {
    const connectivity = buildConnectivity([
      { origin_city_slug: 'a', destination_city_slug: 'b', origin_iata: 'AAA', destination_iata: 'BBB', distance_km: 1000 },
      { origin_city_slug: 'a', destination_city_slug: 'c', origin_iata: 'AAA', destination_iata: 'CCC', avg_duration_min: 120 },
    ], { enforce: true });
    expect(connectivity.cityDest.get('a')).toEqual(new Set(['c']));
  });
});
