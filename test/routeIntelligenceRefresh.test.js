jest.mock('../src/clients/supabase', () => {
  const responses = {};
  const updateCalls = [];
  function makeBuilder(table) {
    const builder = {
      select: () => builder,
      order: () => builder,
      range: (from, to) => {
        const cfg = (responses[table] && responses[table].select) || { data: [], error: null };
        // Faithfully page a slice of the configured dataset so a paginated scan
        // (which walks range windows until a short page) is exercised, not just a
        // single all-rows fetch. An error config still surfaces on the first call.
        if (cfg.error) return Promise.resolve({ data: null, error: cfg.error });
        const all = cfg.data || [];
        return Promise.resolve({ data: all.slice(from, to + 1), error: null });
      },
      update: (patch) => ({
        eq: (col, val) => {
          updateCalls.push({ table, patch, col, val });
          return Promise.resolve((responses[table] && responses[table].update) || { error: null });
        },
      }),
      then: (resolve, reject) => Promise.resolve((responses[table] && responses[table].select) || { data: [], error: null }).then(resolve, reject),
    };
    return builder;
  }
  return {
    from: jest.fn((table) => makeBuilder(table)),
    __setResponse: (table, key, cfg) => { responses[table] = responses[table] || {}; responses[table][key] = cfg; },
    __reset: () => { for (const k of Object.keys(responses)) delete responses[k]; updateCalls.length = 0; },
    __updateCalls: updateCalls,
  };
});
jest.mock('../src/utils/log', () => jest.fn());

const supa = require('../src/clients/supabase');
const log = require('../src/utils/log');
const { refreshRouteIntelligenceOnce, computeAirlineCounts } = require('../src/services/routeIntelligenceRefresh');

beforeEach(() => {
  supa.from.mockClear();
  supa.__reset();
  log.mockClear();
});

test('computeAirlineCounts groups distinct airline_id per (origin,dest) pair', async () => {
  supa.__setResponse('route_airlines', 'select', {
    data: [
      { route_origin_iata: 'BER', route_destination_iata: 'CDG', airline_id: 'lh' },
      { route_origin_iata: 'BER', route_destination_iata: 'CDG', airline_id: 'af' },
      { route_origin_iata: 'BER', route_destination_iata: 'CDG', airline_id: 'lh' }, // duplicate observation, not double-counted
      { route_origin_iata: 'BER', route_destination_iata: 'LHR', airline_id: 'ba' },
    ],
    error: null,
  });
  const counts = await computeAirlineCounts();
  expect(counts.get('BER-CDG').size).toBe(2);
  expect(counts.get('BER-LHR').size).toBe(1);
});

test('no-ops cleanly when route_airlines has no rows', async () => {
  supa.__setResponse('route_airlines', 'select', { data: [], error: null });
  supa.__setResponse('route_pages', 'select', { data: [{ id: '1', origin_iata: 'BER', destination_iata: 'CDG' }], error: null });
  await refreshRouteIntelligenceOnce();
  expect(supa.__updateCalls).toHaveLength(1);
  expect(supa.__updateCalls[0].patch.airline_count).toBe(0);
});

test('writes the computed distinct airline count back onto the matching route_pages row', async () => {
  supa.__setResponse('route_airlines', 'select', {
    data: [
      { route_origin_iata: 'BER', route_destination_iata: 'CDG', airline_id: 'lh' },
      { route_origin_iata: 'BER', route_destination_iata: 'CDG', airline_id: 'af' },
    ],
    error: null,
  });
  supa.__setResponse('route_pages', 'select', { data: [{ id: '1', origin_iata: 'BER', destination_iata: 'CDG' }], error: null });

  await refreshRouteIntelligenceOnce();

  expect(supa.__updateCalls).toHaveLength(1);
  expect(supa.__updateCalls[0]).toEqual(expect.objectContaining({ table: 'route_pages', col: 'id', val: '1', patch: { airline_count: 2 } }));
});

test('a route_airlines read failure aborts the cycle without throwing or updating anything', async () => {
  supa.__setResponse('route_airlines', 'select', { data: null, error: { message: 'boom' } });
  await expect(refreshRouteIntelligenceOnce()).resolves.toBeUndefined();
  expect(log).toHaveBeenCalledWith('warn', 'route_intelligence_refresh_read_failed', expect.objectContaining({ error: 'boom' }));
  expect(supa.__updateCalls).toHaveLength(0);
});

test('a route_pages read failure aborts the cycle without throwing', async () => {
  supa.__setResponse('route_airlines', 'select', { data: [], error: null });
  supa.__setResponse('route_pages', 'select', { data: null, error: { message: 'boom' } });
  await expect(refreshRouteIntelligenceOnce()).resolves.toBeUndefined();
  expect(log).toHaveBeenCalledWith('warn', 'route_intelligence_refresh_route_pages_read_failed', expect.objectContaining({ error: 'boom' }));
});

test('[SCALE] refreshes EVERY published route, not just the first PostgREST page (>1000)', async () => {
  // Regression for the NULL-count blind spot: a bare .select() capped at 1000
  // rows left every route beyond the cap stuck at NULL airline_count (thin /
  // noindex forever). The scan must page until a short page ends it. Here 1500
  // routes span two pages (1000 + 500); all must be updated.
  supa.__setResponse('route_airlines', 'select', { data: [], error: null });
  const routes = Array.from({ length: 1500 }, (_, i) => ({
    id: String(i), origin_iata: 'BER', destination_iata: `D${i}`,
  }));
  supa.__setResponse('route_pages', 'select', { data: routes, error: null });

  await refreshRouteIntelligenceOnce();

  // Every one of the 1500 routes got its airline_count written (→ 0 here, which
  // moves it out of NULL and into the backfill's reach), proving no route was
  // silently dropped past the 1000-row cap.
  expect(supa.__updateCalls).toHaveLength(1500);
  expect(supa.__updateCalls.every((c) => c.patch.airline_count === 0)).toBe(true);
});

test('a single row update failure is logged but does not stop other rows from updating', async () => {
  supa.__setResponse('route_airlines', 'select', { data: [], error: null });
  supa.__setResponse('route_pages', 'select', {
    data: [{ id: '1', origin_iata: 'BER', destination_iata: 'CDG' }, { id: '2', origin_iata: 'FRA', destination_iata: 'JFK' }],
    error: null,
  });
  supa.__setResponse('route_pages', 'update', { error: { message: 'update failed' } });

  await refreshRouteIntelligenceOnce();

  expect(log).toHaveBeenCalledWith('warn', 'route_intelligence_refresh_update_failed', expect.objectContaining({ error: 'update failed' }));
  expect(supa.__updateCalls).toHaveLength(2);
});
