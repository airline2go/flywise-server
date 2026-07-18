jest.mock('../src/clients/supabase', () => null);
jest.mock('../src/utils/log', () => jest.fn());

const { computeTrend } = require('../src/services/routePriceHistoryRefresh');

describe('computeTrend', () => {
  test('returns null below the minimum sample count', () => {
    expect(computeTrend([])).toBeNull();
    expect(computeTrend([100])).toBeNull();
    expect(computeTrend([100, 120, 130])).toBeNull(); // 3 < MIN_SAMPLES_FOR_TREND (4)
  });

  test("flags 'down' when the recent tail is meaningfully cheaper", () => {
    expect(computeTrend([130, 130, 130, 130, 130, 130, 90, 90, 90])).toBe('down');
  });

  test("flags 'up' when the recent tail is meaningfully pricier", () => {
    expect(computeTrend([100, 100, 100, 100, 100, 100, 130, 130, 130])).toBe('up');
  });

  test("flags 'stable' inside the dead-band", () => {
    expect(computeTrend([100, 101, 99, 100, 100, 100, 100, 101, 99])).toBe('stable');
  });

  test('a <3% move stays stable (dead-band boundary)', () => {
    // recent mean ~102 vs older mean ~100 => +2% => within ±3% band
    expect(computeTrend([100, 100, 100, 100, 100, 100, 102, 102, 102])).toBe('stable');
  });
});
