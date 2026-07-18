jest.mock('../src/clients/supabase', () => {
  const responses = {}; // table -> { maybeSingle, result }
  function makeBuilder(table) {
    const cfg = responses[table] || {};
    const builder = {
      select: () => builder,
      eq: () => builder,
      insert: (payload) => { (cfg.inserts = cfg.inserts || []).push(payload); return builder; },
      update: (payload) => { (cfg.updates = cfg.updates || []).push(payload); return builder; },
      maybeSingle: () => Promise.resolve(cfg.maybeSingle || { data: null, error: null }),
      then: (resolve, reject) => Promise.resolve(cfg.result || { data: null, error: null }).then(resolve, reject),
    };
    return builder;
  }
  return {
    from: jest.fn((table) => makeBuilder(table)),
    __setResponse: (table, cfg) => { responses[table] = cfg; },
    __getCalls: (table) => responses[table] || {},
    __reset: () => { for (const k of Object.keys(responses)) delete responses[k]; },
  };
});
jest.mock('../src/utils/log', () => jest.fn());

const { haversineDistanceKm, classifyHaul, ensureAirportExists, ensureCityExists } = require('../src/services/routePages');
const supa = require('../src/clients/supabase');

beforeEach(() => {
  supa.__reset();
  supa.from.mockClear();
});

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

  test('distance at exactly 1500km is medium-haul', () => {
    expect(classifyHaul(1500)).toBe('medium-haul');
  });

  test('a 1500–4000km route (e.g. Berlin–Valencia) is medium-haul', () => {
    expect(classifyHaul(1790)).toBe('medium-haul');
    expect(classifyHaul(3999)).toBe('medium-haul');
  });

  test('distance at exactly 4000km is long-haul', () => {
    expect(classifyHaul(4000)).toBe('long-haul');
  });

  test('a clearly intercontinental distance is long-haul', () => {
    expect(classifyHaul(5000)).toBe('long-haul');
  });
});

describe('ensureAirportExists', () => {
  test('creates a new airport row with the IATA code as a placeholder name', async () => {
    supa.__setResponse('airports', { maybeSingle: { data: null, error: null }, result: { data: null, error: null } });
    await ensureAirportExists('MUC', 'city-1', 'DE', 48.35, 11.78);
    const inserts = supa.__getCalls('airports').inserts;
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ iata_code: 'MUC', airport_name: 'MUC', city_id: 'city-1', country_code: 'DE', latitude: 48.35, longitude: 11.78, status: 'published' });
  });

  test('backfills only the null fields on an existing row, never overwriting a real value', async () => {
    supa.__setResponse('airports', {
      maybeSingle: { data: { id: 'airport-1', city_id: null, country_code: 'DE', latitude: null, longitude: null }, error: null },
      result: { data: null, error: null },
    });
    await ensureAirportExists('MUC', 'city-1', 'AT', 48.35, 11.78);
    const updates = supa.__getCalls('airports').updates;
    expect(updates).toHaveLength(1);
    // city_id/lat/lng were null -> backfilled; country_code was already 'DE' -> left untouched
    expect(updates[0]).toMatchObject({ city_id: 'city-1', latitude: 48.35, longitude: 11.78 });
    expect(updates[0].country_code).toBeUndefined();
  });

  test('is a no-op that never throws when the query fails', async () => {
    supa.__setResponse('airports', { maybeSingle: { data: null, error: { message: 'connection lost' } } });
    await expect(ensureAirportExists('MUC', 'city-1', 'DE')).resolves.toBeUndefined();
  });

  test('silently does nothing without an IATA code', async () => {
    await ensureAirportExists(null, 'city-1', 'DE');
    expect(supa.from).not.toHaveBeenCalled();
  });
});

describe('ensureCityExists -> ensureAirportExists linkage', () => {
  test('touching an existing city also keeps its airport row in sync', async () => {
    supa.__setResponse('cities', { maybeSingle: { data: { id: 'city-42', airport_codes: ['MUC'] }, error: null } });
    supa.__setResponse('airports', { maybeSingle: { data: null, error: null }, result: { data: null, error: null } });

    await ensureCityExists('munich', 'München', 'DE', 'MUC', 48.35, 11.78);

    const airportInserts = supa.__getCalls('airports').inserts;
    expect(airportInserts).toHaveLength(1);
    expect(airportInserts[0]).toMatchObject({ iata_code: 'MUC', city_id: 'city-42', country_code: 'DE', latitude: 48.35, longitude: 11.78 });
  });

  test('a city with no matching airportCode does not touch the airports table', async () => {
    supa.__setResponse('cities', { maybeSingle: { data: { id: 'city-42', airport_codes: [] }, error: null } });
    await ensureCityExists('munich', 'München', 'DE', null);
    expect(supa.__getCalls('airports').inserts).toBeUndefined();
  });
});
