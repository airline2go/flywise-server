const { filterRoutesForSeoBatch } = require('../src/services/seoBatchProcessor');
const { SEO_CORE_ROUTES, SEO_CORE_ROUTE_COUNT } = require('../src/services/seoRouteCore');

describe('SEO batch core-route fence', () => {
  test('versioned core cohort contains exactly 70 routes', () => {
    expect(SEO_CORE_ROUTE_COUNT).toBe(70);
    expect(SEO_CORE_ROUTES.size).toBe(70);
  });

  test('core-only batch excludes non-core routes', () => {
    const routes = [
      { slug: 'alicante-barcelona', created_at: '2026-01-01T00:00:00Z', airline_count: 2 },
      { slug: 'non-core-example', created_at: '2026-01-02T00:00:00Z', airline_count: 9 },
      { slug: 'lgw-pmi', created_at: '2026-01-03T00:00:00Z', airline_count: 1 },
    ];

    const result = filterRoutesForSeoBatch(routes, true).map((route) => route.slug);

    expect(result).toEqual(expect.arrayContaining(['alicante-barcelona', 'lgw-pmi']));
    expect(result).not.toContain('non-core-example');
    expect(result).toHaveLength(2);
  });

  test('core-only can be explicitly disabled for controlled rollback', () => {
    const routes = [
      { slug: 'non-core-example', created_at: '2026-01-01T00:00:00Z' },
    ];

    expect(filterRoutesForSeoBatch(routes, false)).toHaveLength(1);
  });
});
