process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.SEARCH_SESSION_SECRET = 'test-search-session-secret';

const mockRedisValues = new Map();
const mockRedis = {
  status: 'end',
  get: jest.fn(async (key) => mockRedisValues.get(key) || null),
  set: jest.fn(async (key, value, ...args) => {
    if (args.includes('NX')) {
      if (mockRedisValues.has(key)) return null;
      mockRedisValues.set(key, value);
      return 'OK';
    }
    mockRedisValues.set(key, value);
    return 'OK';
  }),
  eval: jest.fn(async (_script, _numKeys, key, token) => {
    if (mockRedisValues.get(key) !== token) return 0;
    mockRedisValues.delete(key);
    return 1;
  }),
  incr: jest.fn(async () => 1),
  expire: jest.fn(async () => 1),
  pexpire: jest.fn(async () => 1),
  pttl: jest.fn(async () => 0),
};
jest.mock('../src/clients/redis', () => mockRedis);

jest.mock('../src/clients/supabase', () => {
  const responses = {};
  const updateCalls = [];
  function makeBuilder(table) {
    const cfg = responses[table] || {};
    const builder = {
      select: () => builder,
      eq: () => builder,
      neq: () => builder,
      insert: () => builder,
      limit: () => builder,
      maybeSingle: () => Promise.resolve(cfg.result || { data: null, error: null }),
      then: (resolve, reject) => Promise.resolve(cfg.result || { data: null, error: null }).then(resolve, reject),
      update: (patch) => {
        const updateBuilder = {
          eq: (col, val) => { updateCalls.push({ table, patch, col, val }); return updateBuilder; },
          then: (resolve, reject) => Promise.resolve({ error: null }).then(resolve, reject),
          catch: () => updateBuilder,
        };
        return updateBuilder;
      },
    };
    return builder;
  }
  return {
    from: jest.fn((table) => makeBuilder(table)),
    __setResponse: (table, cfg) => { responses[table] = cfg; },
    __reset: () => { for (const k of Object.keys(responses)) delete responses[k]; updateCalls.length = 0; },
    __updateCalls: updateCalls,
  };
});

const mockDuffelFn = jest.fn();
jest.mock('../src/services/duffel', () => {
  const fn = (...args) => mockDuffelFn(...args);
  return fn;
});

const mockGetTicketProfitTiers = jest.fn().mockResolvedValue([{ from: 0, to: null, pct: 10, fixed: 0 }]);
const mockComputeTieredMargin = jest.fn().mockReturnValue(5);
const mockGetAdminConfig = jest.fn().mockResolvedValue(null);
const mockSetAdminConfig = jest.fn().mockResolvedValue();
jest.mock('../src/services/adminConfig', () => ({
  getTicketProfitTiers: (...args) => mockGetTicketProfitTiers(...args),
  computeTieredMargin: (...args) => mockComputeTieredMargin(...args),
  getAdminConfig: (...args) => mockGetAdminConfig(...args),
  setAdminConfig: (...args) => mockSetAdminConfig(...args),
}));

const mockNormalizeOffer = jest.fn((o) => ({ id: o.id, price: o.total_amount, normalized: true }));
jest.mock('../src/services/normalizeOffer', () => ({
  normalizeOffer: (...args) => mockNormalizeOffer(...args),
}));

jest.mock('../src/utils/log', () => jest.fn());

const express = require('express');
const request = require('supertest');
const supa = require('../src/clients/supabase');

function buildApp() {
  const app = express();
  app.use(express.json());
  require('../src/routes/search.routes')(app);
  return app;
}

const app = buildApp();
const { createSearchSession } = require('../src/middleware/searchGuard');
const { resetPublishedRouteCache } = require('../src/routes/search.routes');

function ss() { return createSearchSession().token; }
function authed(req) { return req.set('X-Search-Session', ss()); }
function publishPair(from, to) {
  supa.__setResponse('route_pages', {
    result: { data: [{ origin_iata: from, destination_iata: to, status: 'published' }], error: null },
  });
}

beforeEach(() => {
  resetPublishedRouteCache();
  supa.__reset();
  mockRedis.status = 'end';
  mockRedisValues.clear();
  mockRedis.get.mockClear();
  mockRedis.set.mockClear();
  mockRedis.eval.mockClear();
  mockRedis.incr.mockClear();
  mockRedis.expire.mockClear();
  mockRedis.pexpire.mockClear();
  mockRedis.pttl.mockClear();
  mockDuffelFn.mockReset();
  mockGetTicketProfitTiers.mockClear();
  mockComputeTieredMargin.mockClear();
  mockGetAdminConfig.mockReset().mockResolvedValue(null);
  mockSetAdminConfig.mockClear();
  mockNormalizeOffer.mockClear();
});

describe('POST /search', () => {
  test('rejects a one-way search missing required fields', async () => {
    const res = await authed(request(app).post('/search')).send({ origin: 'BER' });
    expect(res.status).toBe(400);
    expect(mockDuffelFn).not.toHaveBeenCalled();
  });

  test('a valid one-way search calls Duffel with a single slice and returns normalized offers', async () => {
    mockDuffelFn.mockResolvedValue({ data: { id: 'orq_1', offers: [{ id: 'off_1', total_amount: '100.00' }] } });
    const res = await authed(request(app).post('/search')).send({ origin: 'BER', destination: 'CDG', departure_date: '2026-08-01' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.total).toBe(1);
    const [, , body] = mockDuffelFn.mock.calls[0];
    expect(body.data.slices).toEqual([{ origin: 'BER', destination: 'CDG', departure_date: '2026-08-01' }]);
  });

  test('a round-trip search includes both outbound and return legs', async () => {
    mockDuffelFn.mockResolvedValue({ data: { id: 'orq_2', offers: [] } });
    await authed(request(app).post('/search')).send({ origin: 'BER', destination: 'FRA', departure_date: '2026-08-01', return_date: '2026-08-10' });
    const [, , body] = mockDuffelFn.mock.calls[0];
    expect(body.data.slices).toEqual([
      { origin: 'BER', destination: 'FRA', departure_date: '2026-08-01' },
      { origin: 'FRA', destination: 'BER', departure_date: '2026-08-10' },
    ]);
  });

  test('a multi-city search sends the same normalized slices used by its cache key', async () => {
    mockDuffelFn.mockResolvedValue({ data: { id: 'orq_3', offers: [] } });
    await authed(request(app).post('/search')).send({
      slices: [
        { origin: ' ber ', destination: ' cdg ', departure_date: ' 2026-08-01 ' },
        { origin: 'cdg', destination: ' lis', departure_date: '2026-08-03' },
      ],
    });
    const [, , body] = mockDuffelFn.mock.calls[0];
    expect(body.data.slices).toEqual([
      { origin: 'BER', destination: 'CDG', departure_date: '2026-08-01' },
      { origin: 'CDG', destination: 'LIS', departure_date: '2026-08-03' },
    ]);
  });

  test('an identical repeated search within the cache window is served from cache', async () => {
    mockDuffelFn.mockResolvedValue({ data: { id: 'orq_4', offers: [{ id: 'off_4', total_amount: '50.00' }] } });
    const payload = { origin: 'MUC', destination: 'LHR', departure_date: '2026-09-01' };
    const first = await authed(request(app).post('/search')).send(payload);
    const second = await authed(request(app).post('/search')).send(payload);
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(mockDuffelFn).toHaveBeenCalledTimes(1);
  });

  test('coalesces concurrent identical cache misses into one Duffel request', async () => {
    mockRedis.status = 'ready';
    const payload = { origin: 'BOS', destination: 'LIS', departure_date: '2027-08-03' };
    let resolveDuffel;
    let markDuffelStarted;
    const duffelStarted = new Promise((resolve) => { markDuffelStarted = resolve; });
    mockDuffelFn.mockImplementationOnce(() => {
      markDuffelStarted();
      return new Promise((resolve) => { resolveDuffel = resolve; });
    });

    const first = authed(request(app).post('/search')).send(payload);
    const second = authed(request(app).post('/search')).send(payload);
    const responses = Promise.all([first, second]);
    await duffelStarted;
    expect(mockDuffelFn).toHaveBeenCalledTimes(1);

    resolveDuffel({ data: { id: 'orq_single_flight', offers: [{ id: 'off_single_flight', total_amount: '75.00' }] } });
    const [firstResponse, secondResponse] = await responses;

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(secondResponse.body).toEqual(firstResponse.body);
    expect(mockDuffelFn).toHaveBeenCalledTimes(1);
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^search_lock:v1:/), expect.any(String), 'PX', 30000, 'NX'
    );
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.any(String), 1, expect.stringMatching(/^search_lock:v1:/), expect.any(String)
    );
  });
});

describe('GET /route-price', () => {
  test('requires both from and to', async () => {
    const res = await request(app).get('/route-price?from=BER');
    expect(res.status).toBe(400);
  });

  test('rejects an unpublished route without calling Duffel', async () => {
    const res = await request(app).get('/route-price?from=ABC&to=XYZ');
    expect(res.status).toBe(403);
    expect(mockDuffelFn).not.toHaveBeenCalled();
  });

  test('returns a fresh cached price without calling Duffel', async () => {
    publishPair('BER', 'CDG');
    mockGetAdminConfig.mockResolvedValue({ price: 120, currency: 'EUR', departure_date: '2026-08-01', insights: null, fetchedAt: new Date().toISOString() });
    const res = await request(app).get('/route-price?from=BER&to=CDG');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ ok: true, price: 120, cached: true }));
    expect(mockDuffelFn).not.toHaveBeenCalled();
  });

  test('a published route with no cache returns price:null and never calls Duffel', async () => {
    publishPair('JFK', 'LAX');
    mockGetAdminConfig.mockResolvedValue(null);
    const res = await request(app).get('/route-price?from=JFK&to=LAX');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ ok: true, price: null }));
    expect(mockDuffelFn).not.toHaveBeenCalled();
  });
});

describe('fetchAndCacheRoutePrice (authorized internal warming path)', () => {
  const { fetchAndCacheRoutePrice } = require('../src/routes/search.routes');
  test('a live Duffel call includes cheapest/fastest/bestValue and tags logContext', async () => {
    mockGetAdminConfig.mockResolvedValue(null);
    mockDuffelFn.mockResolvedValue({
      data: {
        id: 'orq_7',
        offers: [
          { id: 'cheap', total_amount: '49.00', total_currency: 'EUR', slices: [{ duration: 'PT5H', segments: [{ marketing_carrier: { name: 'A' } }, { marketing_carrier: { name: 'A' } }] }] },
          { id: 'fast', total_amount: '199.00', total_currency: 'EUR', slices: [{ duration: 'PT1H30M', segments: [{ marketing_carrier: { name: 'B' } }] }] },
        ],
      },
    });
    const res = await fetchAndCacheRoutePrice('ber', 'cdg', 21, 'route_price_BER_CDG');
    expect(res.offers).toBeTruthy();
    expect(mockDuffelFn).toHaveBeenCalledWith('POST', expect.any(String), expect.any(Object), null,
      expect.objectContaining({ logContext: { route_origin: 'BER', route_destination: 'CDG' }, source: 'admin' }));
  });
});

describe('selectRouteOffers', () => {
  const { selectRouteOffers } = require('../src/routes/search.routes');
  test('picks the correct cheapest, fastest, and best-value offer from a 3-offer set', () => {
    const priced = [
      { id: 'cheap', price: 49, durationMin: 300, stops: 1, airline: 'A' },
      { id: 'fast', price: 199, durationMin: 90, stops: 0, airline: 'B' },
      { id: 'balanced', price: 89, durationMin: 150, stops: 0, airline: 'C' },
    ];
    const result = selectRouteOffers(priced);
    expect(result.cheapest.id).toBe('cheap');
    expect(result.fastest.id).toBe('fast');
    expect(result.bestValue.id).toBe('balanced');
  });
});

describe('warmRoutePricesOnce', () => {
  const { warmRoutePricesOnce } = require('../src/routes/search.routes');
  const DUFFEL_OFFER = { data: { id: 'orq_w', offers: [{ id: 'off_w', total_amount: '150.00', total_currency: 'EUR', slices: [{ duration: 'PT3H', segments: [{ marketing_carrier: { name: 'Airpiv Air' } }] }] }] } };
  const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

  test("excludes refresh_frequency='none' routes entirely", async () => {
    supa.__setResponse('route_pages', { result: { data: [{ origin_iata: 'BER', destination_iata: 'FRA', refresh_frequency: 'none' }], error: null } });
    mockGetAdminConfig.mockResolvedValue(null);
    mockDuffelFn.mockResolvedValue(DUFFEL_OFFER);
    await warmRoutePricesOnce();
    expect(mockDuffelFn).not.toHaveBeenCalled();
  });

  test("warms a '6h' route whose cache is 7h old", async () => {
    supa.__setResponse('route_pages', { result: { data: [{ origin_iata: 'MUC', destination_iata: 'PMI', refresh_frequency: '6h' }], error: null } });
    mockGetAdminConfig.mockResolvedValue({ price: 80, fetchedAt: hoursAgo(7) });
    mockDuffelFn.mockResolvedValue(DUFFEL_OFFER);
    await warmRoutePricesOnce();
    expect(mockDuffelFn).toHaveBeenCalled();
  });
});

describe('GET /search/airports', () => {
  test('returns an empty list for a too-short query without calling Duffel', async () => {
    const res = await authed(request(app).get('/search/airports?q=b'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, airports: [] });
    expect(mockDuffelFn).not.toHaveBeenCalled();
  });

  test('de-dupes a city and its same-coded airport as two distinct results', async () => {
    mockDuffelFn.mockResolvedValue({
      data: [{
        type: 'city', iata_code: 'MUC', name: 'Munich', iata_country_code: 'DE',
        airports: [{ iata_code: 'MUC', name: 'Munich Airport', city_name: 'Munich', iata_country_code: 'DE', latitude: 48.35, longitude: 11.78 }],
      }],
    });
    const res = await authed(request(app).get('/search/airports?q=munich'));
    expect(res.status).toBe(200);
    expect(res.body.airports).toHaveLength(2);
  });
});

describe('GET /debug/raw', () => {
  test('requires admin auth', async () => {
    const res = await request(app).get('/debug/raw?origin=BER&destination=ORD&departure_date=2026-06-25');
    expect(res.status).toBe(401);
  });
});

describe('avgDurationExcludingOutliers', () => {
  const { avgDurationExcludingOutliers } = require('../src/routes/search.routes');
  test('excludes itineraries longer than 3x the shortest', () => {
    expect(avgDurationExcludingOutliers([66, 71, 80, 393, 410])).toBe(72);
  });
});
