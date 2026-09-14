const { routeSeoPriorityScore, sortRoutesForSeo } = require('../src/services/seo/routePriority');

describe('route SEO priority', () => {
  test('prefers routes without generated SEO when evidence is otherwise equal', () => {
    const generated = { airline_count: 1, itinerary_count: 1, seo_generated_at: '2026-01-01T00:00:00Z', created_at: '2026-01-02T00:00:00Z' };
    const pending = { airline_count: 1, itinerary_count: 1, created_at: '2026-01-01T00:00:00Z' };
    expect(routeSeoPriorityScore(pending)).toBeGreaterThan(routeSeoPriorityScore(generated));
    expect(sortRoutesForSeo([generated, pending])[0]).toBe(pending);
  });
});
