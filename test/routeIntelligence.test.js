const { buildRouteIntelligenceSnapshot } = require('../src/services/routeIntelligence');

test('returns null for a null/undefined route', () => {
  expect(buildRouteIntelligenceSnapshot(null)).toBeNull();
  expect(buildRouteIntelligenceSnapshot(undefined)).toBeNull();
});

test('assembles basic fields straight off the route row', () => {
  const snapshot = buildRouteIntelligenceSnapshot({
    origin_city: 'Berlin', destination_city: 'Paris',
    origin_country: 'DE', destination_country: 'FR',
    origin_iata: 'BER', destination_iata: 'CDG',
    distance_km: 878, haul_type: 'short-haul',
  });
  expect(snapshot.basic).toEqual({
    originCity: 'Berlin', destinationCity: 'Paris',
    originCountry: 'DE', destinationCountry: 'FR',
    originIata: 'BER', destinationIata: 'CDG',
    distanceKm: 878, haulType: 'short-haul',
    isDomestic: false,
  });
});

test('flags isDomestic when origin and destination countries match', () => {
  const snapshot = buildRouteIntelligenceSnapshot({ origin_country: 'DE', destination_country: 'DE' });
  expect(snapshot.basic.isDomestic).toBe(true);
});

test('isDomestic is false when either country is missing (never a false positive from two nulls)', () => {
  expect(buildRouteIntelligenceSnapshot({ origin_country: null, destination_country: null }).basic.isDomestic).toBe(false);
  expect(buildRouteIntelligenceSnapshot({ origin_country: 'DE', destination_country: null }).basic.isDomestic).toBe(false);
});

test('assembles operational fields from the Phase 1 columns when present', () => {
  const snapshot = buildRouteIntelligenceSnapshot({
    direct_flight_available: true, all_direct: false,
    avg_duration_min: 120, min_duration_min: 105,
    stop_distribution: { 0: 3, 1: 2 }, airline_count: 4,
    insights_updated_at: '2026-01-01T00:00:00Z',
  });
  expect(snapshot.operational).toEqual({
    directFlightAvailable: true, allDirect: false,
    avgDurationMin: 120, minDurationMin: 105,
    stopDistribution: { 0: 3, 1: 2 }, airlineCount: 4,
    updatedAt: '2026-01-01T00:00:00Z',
  });
});

test('operational fields default to null rather than undefined when not yet populated', () => {
  const snapshot = buildRouteIntelligenceSnapshot({});
  expect(snapshot.operational).toEqual({
    directFlightAvailable: null, allDirect: null,
    avgDurationMin: null, minDurationMin: null,
    stopDistribution: null, airlineCount: null,
    updatedAt: null,
  });
});

test('economic is always null in this phase — consumers must not assume it is populated', () => {
  expect(buildRouteIntelligenceSnapshot({}).economic).toBeNull();
});
