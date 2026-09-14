const {
  evidenceSignals,
  assessEvidence,
  evidencePolicyEnabled,
  assessSeoEvidence,
} = require('../src/services/seo/evidencePolicy');

describe('route SEO evidence policy', () => {
  test('does not treat distance or city metadata as flight evidence', () => {
    const route = { origin_city: 'Berlin', destination_city: 'Paris', distance_km: 878 };
    expect(evidenceSignals(route)).toEqual([]);
    expect(assessEvidence(route).verified).toBe(false);
  });

  test('accepts observed itinerary evidence', () => {
    const route = { itinerary_count: 4, distance_km: 878 };
    expect(evidenceSignals(route)).toEqual(['itinerary_count']);
    expect(assessEvidence(route).verified).toBe(true);
  });

  test('supports an explicit enforcement switch', () => {
    expect(evidencePolicyEnabled({ SEO_EVIDENCE_POLICY_ENFORCED: '0' })).toBe(false);
    expect(evidencePolicyEnabled({ SEO_EVIDENCE_POLICY_ENFORCED: '1' })).toBe(true);
    expect(assessSeoEvidence({}, { SEO_EVIDENCE_POLICY_ENFORCED: '1' }).eligible).toBe(false);
    expect(assessSeoEvidence({}, { SEO_EVIDENCE_POLICY_ENFORCED: '0' }).eligible).toBe(true);
  });
});
