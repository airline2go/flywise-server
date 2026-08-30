// [CONSISTENCY-GUARD] Unit tests for the route-consistency invariants.
const { checkRouteConsistency } = require('../src/services/consistencyValidation');
const { PRICE_FRESHNESS_MS } = require('../src/config/price');

const codes = (issues) => issues.map((i) => i.code);

describe('checkRouteConsistency', () => {
  test('a route whose count matches its airlines and has valid stops is clean', () => {
    const issues = checkRouteConsistency(
      { airline_count: 14, stop_distribution: { 0: 14, 1: 28, 2: 5 } },
      { uniqueRouteAirlines: 14 },
    );
    expect(issues).toEqual([]);
  });

  // Route with MANY airlines but a stale/undercounted scalar (the exact
  // Ibiza → Frankfurt bug: stored 6, real 14).
  test('flags airline_count vs unique route_airlines mismatch', () => {
    const issues = checkRouteConsistency({ airline_count: 6 }, { uniqueRouteAirlines: 14 });
    expect(codes(issues)).toContain('airline-count-mismatch');
  });

  // Route with FEW airlines, consistent → clean.
  test('a small-airline route that agrees is clean', () => {
    const issues = checkRouteConsistency({ airline_count: 2 }, { uniqueRouteAirlines: 2 });
    expect(issues).toEqual([]);
  });

  test('flags displayed price != canonical price', () => {
    const issues = checkRouteConsistency({}, { displayedPrice: 78, canonicalPrice: 76 });
    expect(codes(issues)).toContain('price-mismatch');
  });

  test('flags live=true with a stale checkedAt', () => {
    const staleCheckedAt = new Date(Date.now() - (PRICE_FRESHNESS_MS + 60 * 60 * 1000)).toISOString();
    const issues = checkRouteConsistency({}, { live: true, checkedAt: staleCheckedAt });
    expect(codes(issues)).toContain('live-but-stale');
  });

  test('live=true with a fresh checkedAt is clean', () => {
    const freshCheckedAt = new Date(Date.now() - 60 * 1000).toISOString();
    const issues = checkRouteConsistency({}, { live: true, checkedAt: freshCheckedAt });
    expect(issues).toEqual([]);
  });

  test('flags an empty stop_distribution', () => {
    const issues = checkRouteConsistency({ stop_distribution: {} }, {});
    expect(codes(issues)).toContain('stop-distribution-empty');
  });
});
