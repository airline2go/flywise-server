const { haversineDistanceKm, classifyHaul } = require('../src/services/routePages');

describe('haversineDistanceKm', () => {
  test('distance between same point is 0', () => {
    expect(haversineDistanceKm(52.52, 13.405, 52.52, 13.405)).toBe(0);
  });

  test('Berlin to Paris is approximately 878km', () => {
    const km = haversineDistanceKm(52.52, 13.405, 48.8566, 2.3522);
    expect(km).toBeGreaterThan(860);
    expect(km).toBeLessThan(900);
  });
});

describe('classifyHaul', () => {
  test('distance under 1500km is short-haul', () => {
    expect(classifyHaul(1499)).toBe('short-haul');
  });

  test('distance at exactly 1500km is long-haul', () => {
    expect(classifyHaul(1500)).toBe('long-haul');
  });

  test('distance over 1500km is long-haul', () => {
    expect(classifyHaul(5000)).toBe('long-haul');
  });
});
