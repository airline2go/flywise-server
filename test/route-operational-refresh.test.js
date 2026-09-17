const {
  hasDemandSignal,
  isFresh,
  pickRefreshRoutes,
} = require('../src/services/routeOperationalRefresh');

describe('route operational refresh', () => {
  const now = Date.parse('2026-09-17T00:00:00.000Z');

  test('only routes with demand or manual editorial content are eligible', () => {
    expect(hasDemandSignal({ route_score: 0.2 })).toBe(true);
    expect(hasDemandSignal({ weekly_flights: 1 })).toBe(true);
    expect(hasDemandSignal({ intro_text: 'Guide' })).toBe(true);
    expect(hasDemandSignal({ route_score: 0.1 })).toBe(false);
    expect(hasDemandSignal({})).toBe(false);
  });

  test('freshness is fail-closed for missing, future, and stale timestamps', () => {
    expect(isFresh({ insights_updated_at: '2026-09-01T00:00:00.000Z' }, now)).toBe(true);
    expect(isFresh({ insights_updated_at: '2026-01-01T00:00:00.000Z' }, now)).toBe(false);
    expect(isFresh({ insights_updated_at: '2026-09-18T00:00:00.000Z' }, now)).toBe(false);
    expect(isFresh({}, now)).toBe(false);
  });

  test('stale demand routes are prioritized and duplicate pairs collapse', () => {
    const selected = pickRefreshRoutes([
      { id: 1, origin_iata: 'AAA', destination_iata: 'BBB', route_score: 5, insights_updated_at: '2026-01-01T00:00:00.000Z' },
      { id: 2, origin_iata: 'AAA', destination_iata: 'BBB', route_score: 1, insights_updated_at: '2026-02-01T00:00:00.000Z' },
      { id: 3, origin_iata: 'CCC', destination_iata: 'DDD', weekly_flights: 2, insights_updated_at: null },
      { id: 4, origin_iata: 'EEE', destination_iata: 'FFF', route_score: 0.1, insights_updated_at: null },
    ], now);

    expect(selected).toHaveLength(2);
    expect(selected.map((r) => `${r.origin_iata}-${r.destination_iata}`)).toEqual(['AAA-BBB', 'CCC-DDD']);
  });
});
