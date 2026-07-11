jest.mock('../src/clients/supabase', () => {
  const responses = {};
  const updateCalls = [];
  function makeBuilder(table) {
    const builder = {
      select: () => builder,
      gte: () => builder,
      range: () => Promise.resolve((responses[table] && responses[table].select) || { data: [], error: null }),
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

const mockGetAdminConfig = jest.fn().mockResolvedValue({});
jest.mock('../src/services/adminConfig', () => ({
  getAdminConfig: (...args) => mockGetAdminConfig(...args),
}));

const supa = require('../src/clients/supabase');
const log = require('../src/utils/log');
const { computeRouteScoresOnce, DEFAULT_ROUTE_SCORE_CONFIG } = require('../src/services/routeScore');

function todayIso() { return new Date().toISOString().slice(0, 10); }
function daysAgoIso(n) { return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); }

beforeEach(() => {
  supa.from.mockClear();
  supa.__reset();
  log.mockClear();
  mockGetAdminConfig.mockClear().mockResolvedValue({});
});

test('DEFAULT_ROUTE_SCORE_CONFIG matches the documented defaults', () => {
  expect(DEFAULT_ROUTE_SCORE_CONFIG).toEqual({
    halfLifeDays: 7,
    lookbackDays: 30,
    impressionWeight: 1,
    clickWeight: 10,
    bookingWeight: 100,
    ctrWeight: 50,
    confidenceLowMax: 100,
    confidenceHighMin: 1000,
  });
});

test('no-ops cleanly when route_traffic_daily has no rows for any route', async () => {
  supa.__setResponse('route_traffic_daily', 'select', { data: [], error: null });
  supa.__setResponse('route_pages', 'select', { data: [{ id: '1', slug: 'berlin-paris' }], error: null });
  await computeRouteScoresOnce();
  expect(supa.__updateCalls).toHaveLength(1);
  expect(supa.__updateCalls[0].patch.route_score).toBe(0);
  expect(supa.__updateCalls[0].patch.route_score_confidence).toBe('low');
});

test('computes a weighted score from impressions/clicks/booking_starts and writes it back per route', async () => {
  supa.__setResponse('route_traffic_daily', 'select', {
    data: [{ route_slug: 'berlin-paris', day: todayIso(), impressions: 100, clicks: 10, booking_starts: 2 }],
    error: null,
  });
  supa.__setResponse('route_pages', 'select', { data: [{ id: '1', slug: 'berlin-paris' }], error: null });

  await computeRouteScoresOnce();

  expect(supa.__updateCalls).toHaveLength(1);
  const { patch, col, val } = supa.__updateCalls[0];
  expect(col).toBe('id');
  expect(val).toBe('1');
  // decay ≈ 1 for "today" (age 0 days) → score ≈ 100*1 + 10*10 + 2*100 + 50*(10/100) = 100+100+200+5 = 405
  expect(patch.route_score).toBeCloseTo(405, 0);
  expect(patch.route_score_confidence).toBe('medium'); // 100 decayed impressions meets the confidenceLowMax threshold exactly
  expect(patch.route_score_updated_at).toEqual(expect.any(String));
});

test('older traffic contributes less than fresher traffic due to recency decay', async () => {
  supa.__setResponse('route_traffic_daily', 'select', {
    data: [
      { route_slug: 'fresh-route', day: todayIso(), impressions: 100, clicks: 0, booking_starts: 0 },
      { route_slug: 'stale-route', day: daysAgoIso(30), impressions: 100, clicks: 0, booking_starts: 0 },
    ],
    error: null,
  });
  supa.__setResponse('route_pages', 'select', {
    data: [{ id: 'fresh', slug: 'fresh-route' }, { id: 'stale', slug: 'stale-route' }],
    error: null,
  });

  await computeRouteScoresOnce();

  const freshScore = supa.__updateCalls.find((c) => c.val === 'fresh').patch.route_score;
  const staleScore = supa.__updateCalls.find((c) => c.val === 'stale').patch.route_score;
  expect(freshScore).toBeGreaterThan(staleScore);
});

test('confidence escalates from low to medium to high as decayed impressions cross the configured thresholds', async () => {
  supa.__setResponse('route_traffic_daily', 'select', {
    data: [
      { route_slug: 'low-route', day: todayIso(), impressions: 10, clicks: 0, booking_starts: 0 },
      { route_slug: 'medium-route', day: todayIso(), impressions: 500, clicks: 0, booking_starts: 0 },
      { route_slug: 'high-route', day: todayIso(), impressions: 5000, clicks: 0, booking_starts: 0 },
    ],
    error: null,
  });
  supa.__setResponse('route_pages', 'select', {
    data: [
      { id: 'low', slug: 'low-route' }, { id: 'medium', slug: 'medium-route' }, { id: 'high', slug: 'high-route' },
    ],
    error: null,
  });

  await computeRouteScoresOnce();

  expect(supa.__updateCalls.find((c) => c.val === 'low').patch.route_score_confidence).toBe('low');
  expect(supa.__updateCalls.find((c) => c.val === 'medium').patch.route_score_confidence).toBe('medium');
  expect(supa.__updateCalls.find((c) => c.val === 'high').patch.route_score_confidence).toBe('high');
});

test('respects admin-tunable weights from route_score_config', async () => {
  mockGetAdminConfig.mockResolvedValue({ impressionWeight: 5, clickWeight: 0, bookingWeight: 0, ctrWeight: 0 });
  supa.__setResponse('route_traffic_daily', 'select', {
    data: [{ route_slug: 'berlin-paris', day: todayIso(), impressions: 10, clicks: 100, booking_starts: 100 }],
    error: null,
  });
  supa.__setResponse('route_pages', 'select', { data: [{ id: '1', slug: 'berlin-paris' }], error: null });

  await computeRouteScoresOnce();

  // Only impressionWeight (5) counts; click/booking/ctr weights zeroed out → score ≈ 10*5 = 50
  expect(supa.__updateCalls[0].patch.route_score).toBeCloseTo(50, 0);
});

test('a route_traffic_daily read failure aborts the cycle without throwing', async () => {
  supa.__setResponse('route_traffic_daily', 'select', { data: null, error: { message: 'boom' } });
  await expect(computeRouteScoresOnce()).resolves.toBeUndefined();
  expect(log).toHaveBeenCalledWith('warn', 'route_score_read_failed', expect.objectContaining({ error: 'boom' }));
  expect(supa.__updateCalls).toHaveLength(0);
});

test('a route_pages read failure aborts the cycle without throwing', async () => {
  supa.__setResponse('route_traffic_daily', 'select', { data: [], error: null });
  supa.__setResponse('route_pages', 'select', { data: null, error: { message: 'boom' } });
  await expect(computeRouteScoresOnce()).resolves.toBeUndefined();
  expect(log).toHaveBeenCalledWith('warn', 'route_score_route_pages_read_failed', expect.objectContaining({ error: 'boom' }));
});

test('a single row update failure is logged but does not stop other rows from updating', async () => {
  supa.__setResponse('route_traffic_daily', 'select', { data: [], error: null });
  supa.__setResponse('route_pages', 'select', {
    data: [{ id: '1', slug: 'a' }, { id: '2', slug: 'b' }],
    error: null,
  });
  supa.__setResponse('route_pages', 'update', { error: { message: 'update failed' } });

  await computeRouteScoresOnce();

  expect(log).toHaveBeenCalledWith('warn', 'route_score_update_failed', expect.objectContaining({ error: 'update failed' }));
  expect(supa.__updateCalls).toHaveLength(2);
});
