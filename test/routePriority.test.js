const { generatedSeoIsStale, routeSeoPriorityScore, sortRoutesForSeo } = require('../src/services/seo/routePriority');

describe('route SEO priority', () => {
  test('prefers routes without generated SEO when evidence is otherwise equal', () => {
    const generated = { airline_count: 1, itinerary_count: 1, seo_generated_at: '2026-01-01T00:00:00Z', created_at: '2026-01-02T00:00:00Z' };
    const pending = { airline_count: 1, itinerary_count: 1, created_at: '2026-01-01T00:00:00Z' };
    expect(routeSeoPriorityScore(pending)).toBeGreaterThan(routeSeoPriorityScore(generated));
    expect(sortRoutesForSeo([generated, pending])[0]).toBe(pending);
  });

  test('marks generated SEO stale when operational data is newer', () => {
    const stale = {
      seo_generated_at: '2026-09-17T12:00:00Z',
      insights_updated_at: '2026-09-17T16:00:00Z',
    };
    expect(generatedSeoIsStale(stale)).toBe(true);
  });

  test('marks generated SEO stale when pricing data is newer', () => {
    const stale = {
      seo_generated_at: '2026-09-17T12:00:00Z',
      price_updated_at: '2026-09-17T17:00:00Z',
    };
    expect(generatedSeoIsStale(stale)).toBe(true);
  });

  test('does not mark generated SEO stale when generated copy is current', () => {
    const fresh = {
      seo_generated_at: '2026-09-17T17:00:00Z',
      insights_updated_at: '2026-09-17T16:00:00Z',
      price_updated_at: '2026-09-17T16:30:00Z',
    };
    expect(generatedSeoIsStale(fresh)).toBe(false);
  });

  test('stale generated SEO gets refresh priority over otherwise equal fresh generated SEO', () => {
    const stale = {
      airline_count: 1,
      itinerary_count: 1,
      seo_generated_at: '2026-09-17T12:00:00Z',
      insights_updated_at: '2026-09-17T16:00:00Z',
      created_at: '2026-09-16T00:00:00Z',
    };
    const fresh = {
      airline_count: 1,
      itinerary_count: 1,
      seo_generated_at: '2026-09-17T16:00:00Z',
      insights_updated_at: '2026-09-17T15:00:00Z',
      created_at: '2026-09-15T00:00:00Z',
    };
    expect(routeSeoPriorityScore(stale)).toBeGreaterThan(routeSeoPriorityScore(fresh));
    expect(sortRoutesForSeo([fresh, stale])[0]).toBe(stale);
  });

  test('invalid generation timestamp is not treated as stale', () => {
    const invalid = {
      seo_generated_at: 'not-a-date',
      insights_updated_at: '2026-09-17T16:00:00Z',
    };
    expect(generatedSeoIsStale(invalid)).toBe(false);
  });
});
