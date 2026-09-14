const { routeSeoPriorityScore, sortRoutesForSeo } = require('../src/services/seo/routePriority');

describe('route SEO priority', () => {
  test('prefers routes with stronger evidence', () => {
    const strong = { airline_count: 2, itinerary_count: 3, price_sample_count: 4 };
    const weak = { distance_km: 500 };
    expect(routeSeoPriorityScore(strong)).toBeGreaterThan(routeSeoPriorityScore(weak));
  });

  test('returns a new array and keeps deterministic tie ordering', () => {
    const routes = [
      { id: 'old', airline_count: 1, created_at: '2026-01-01T00:00:00Z' },
      { id: 'new', airline_count: 1, created_at: '2026-02-01T00:00:00Z' },
    ];
    const sorted = sortRoutesForSeo(routes);
    expect(sorted.map((r) => r.id)).toEqual(['new', 'old']);
    expect(sorted).not.toBe(routes);
  });
});
