process.env.ADMIN_TOKEN = 'test-admin-token';

jest.mock('../src/clients/supabase', () => {
  const responses = {};
  function makeBuilder(table) {
    const cfg = responses[table] || {};
    const builder = {
      select: () => builder,
      eq: () => builder,
      neq: () => builder,
      then: (resolve, reject) => Promise.resolve(cfg.result || { data: null, error: null }).then(resolve, reject),
    };
    return builder;
  }
  return {
    from: jest.fn((table) => makeBuilder(table)),
    __setResponse: (table, cfg) => { responses[table] = cfg; },
    __reset: () => { for (const k of Object.keys(responses)) delete responses[k]; },
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

beforeEach(() => {
  supa.__reset();
  mockDuffelFn.mockReset();
  mockGetTicketProfitTiers.mockClear();
  mockComputeTieredMargin.mockClear();
  mockGetAdminConfig.mockReset().mockResolvedValue(null);
  mockSetAdminConfig.mockClear();
  mockNormalizeOffer.mockClear();
});

describe('POST /search', () => {
  test('rejects a one-way search missing required fields', async () => {
    const res = await request(app).post('/search').send({ origin: 'BER' });
    expect(res.status).toBe(400);
    expect(mockDuffelFn).not.toHaveBeenCalled();
  });

  test('rejects multi-city search where every leg is invalid', async () => {
    const res = await request(app).post('/search').send({ slices: [{ origin: 'BER' }] });
    expect(res.status).toBe(400);
    expect(mockDuffelFn).not.toHaveBeenCalled();
  });

  test('a valid one-way search calls Duffel with a single slice and returns normalized offers', async () => {
    mockDuffelFn.mockResolvedValue({ data: { id: 'orq_1', offers: [{ id: 'off_1', total_amount: '100.00' }] } });
    const res = await request(app).post('/search').send({ origin: 'BER', destination: 'CDG', departure_date: '2026-08-01' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.total).toBe(1);
    expect(res.body.offers[0]).toEqual({ id: 'off_1', price: '100.00', normalized: true });
    const [, , body] = mockDuffelFn.mock.calls[0];
    expect(body.data.slices).toEqual([{ origin: 'BER', destination: 'CDG', departure_date: '2026-08-01' }]);
  });

  test('a round-trip search includes both outbound and return legs', async () => {
    mockDuffelFn.mockResolvedValue({ data: { id: 'orq_2', offers: [] } });
    await request(app).post('/search').send({ origin: 'BER', destination: 'FRA', departure_date: '2026-08-01', return_date: '2026-08-10' });
    const [, , body] = mockDuffelFn.mock.calls[0];
    expect(body.data.slices).toEqual([
      { origin: 'BER', destination: 'FRA', departure_date: '2026-08-01' },
      { origin: 'FRA', destination: 'BER', departure_date: '2026-08-10' },
    ]);
  });

  test('a multi-city search uses the client-provided slices, dropping invalid legs', async () => {
    mockDuffelFn.mockResolvedValue({ data: { id: 'orq_3', offers: [] } });
    await request(app).post('/search').send({
      slices: [
        { origin: 'BER', destination: 'CDG', departure_date: '2026-08-01' },
        { origin: 'CDG' }, // invalid leg, missing destination/date — should be dropped
        { origin: 'CDG', destination: 'FCO', departure_date: '2026-08-05' },
      ],
    });
    const [, , body] = mockDuffelFn.mock.calls[0];
    expect(body.data.slices).toEqual([
      { origin: 'BER', destination: 'CDG', departure_date: '2026-08-01' },
      { origin: 'CDG', destination: 'FCO', departure_date: '2026-08-05' },
    ]);
  });

  test('an identical repeated search within the cache window is served from cache without hitting Duffel again', async () => {
    mockDuffelFn.mockResolvedValue({ data: { id: 'orq_4', offers: [{ id: 'off_4', total_amount: '50.00' }] } });
    const payload = { origin: 'MUC', destination: 'LHR', departure_date: '2026-09-01' };
    const first = await request(app).post('/search').send(payload);
    const second = await request(app).post('/search').send(payload);
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(mockDuffelFn).toHaveBeenCalledTimes(1);
  });

  test('a Duffel failure surfaces as an error response', async () => {
    const err = new Error('supplier unavailable'); err.status = 503;
    mockDuffelFn.mockRejectedValue(err);
    const res = await request(app).post('/search').send({ origin: 'TXL', destination: 'AMS', departure_date: '2026-10-01' });
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
  });
});

describe('GET /route-price', () => {
  test('requires both from and to', async () => {
    const res = await request(app).get('/route-price?from=BER');
    expect(res.status).toBe(400);
  });

  test('returns a fresh cached price without calling Duffel', async () => {
    mockGetAdminConfig.mockResolvedValue({ price: 120, currency: 'EUR', departure_date: '2026-08-01', insights: null, fetchedAt: new Date().toISOString() });
    const res = await request(app).get('/route-price?from=BER&to=CDG');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ ok: true, price: 120, cached: true }));
    expect(mockDuffelFn).not.toHaveBeenCalled();
  });

  test('returns a stale cached price immediately and revalidates in the background', async () => {
    const staleDate = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
    mockGetAdminConfig.mockResolvedValue({ price: 90, currency: 'EUR', departure_date: '2026-08-01', insights: null, fetchedAt: staleDate });
    mockDuffelFn.mockResolvedValue({ data: { id: 'orq_5', offers: [{ id: 'off_5', total_amount: '95.00', total_currency: 'EUR', slices: [{ duration: 'PT2H', segments: [{ marketing_carrier: { name: 'Lufthansa' } }] }] }] } });
    const res = await request(app).get('/route-price?from=FRA&to=BCN');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ ok: true, price: 90, cached: true, stale: true }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockDuffelFn).toHaveBeenCalled();
  });

  test('a route never priced before makes a live Duffel call and caches the result', async () => {
    mockGetAdminConfig.mockResolvedValue(null);
    mockDuffelFn.mockResolvedValue({ data: { id: 'orq_6', offers: [{ id: 'off_6', total_amount: '200.00', total_currency: 'USD', slices: [{ duration: 'PT5H30M', segments: [{ marketing_carrier: { name: 'United' } }] }] }] } });
    const res = await request(app).get('/route-price?from=JFK&to=LAX');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.price).not.toBeNull();
    expect(mockSetAdminConfig).toHaveBeenCalled();
  });

  test('fails soft (200, price:null) instead of erroring when Duffel is unavailable', async () => {
    mockGetAdminConfig.mockResolvedValue(null);
    mockDuffelFn.mockRejectedValue(new Error('timeout'));
    const res = await request(app).get('/route-price?from=SIN&to=HKG');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ ok: true, price: null }));
  });

  test('a fresh Duffel call includes the cheapest/fastest/bestValue offers object and tags the Duffel call with route logContext', async () => {
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
    const res = await request(app).get('/route-price?from=ber&to=cdg');
    expect(res.status).toBe(200);
    expect(res.body.offers).toBeTruthy();
    expect(res.body.offers.cheapest).toEqual(expect.objectContaining({ price: expect.any(Number) }));
    expect(res.body.offers.fastest).toEqual(expect.objectContaining({ price: expect.any(Number) }));
    expect(res.body.offers.bestValue).toBeTruthy();
    expect(mockDuffelFn).toHaveBeenCalledWith('POST', expect.any(String), expect.any(Object), null,
      expect.objectContaining({ logContext: { route_origin: 'BER', route_destination: 'CDG' } }));
  });

  test('a cached response threads the stored offers object through unchanged', async () => {
    mockGetAdminConfig.mockResolvedValue({
      price: 49, currency: 'EUR', departure_date: '2026-08-01', insights: null,
      offers: { cheapest: { id: 'x', price: 49 }, fastest: { id: 'x', price: 49 }, bestValue: { id: 'x', price: 49 } },
      fetchedAt: new Date().toISOString(),
    });
    const res = await request(app).get('/route-price?from=MUC&to=PMI');
    expect(res.status).toBe(200);
    expect(res.body.offers).toEqual({ cheapest: { id: 'x', price: 49 }, fastest: { id: 'x', price: 49 }, bestValue: { id: 'x', price: 49 } });
  });
});

// [3-OFFER-CACHE] selectRouteOffers() — picks cheapest/fastest/best-value
// from one already-fetched offer set, never a second Duffel call.
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
    // balanced offer: mid-price, short-ish duration, zero stops — should
    // beat both the cheap-but-slow-and-1-stop and the fast-but-expensive one.
    expect(result.bestValue.id).toBe('balanced');
  });

  test('falls back to cheapest for fastest/bestValue when no offer has a parseable duration', () => {
    const priced = [
      { id: 'a', price: 50, durationMin: null, stops: null, airline: null },
      { id: 'b', price: 30, durationMin: null, stops: null, airline: null },
    ];
    const result = selectRouteOffers(priced);
    expect(result.cheapest.id).toBe('b');
    expect(result.fastest.id).toBe('b');
    expect(result.bestValue.id).toBe('b');
  });

  test('excludes durationless offers from fastest/bestValue but keeps them eligible for cheapest', () => {
    const priced = [
      { id: 'cheap-no-duration', price: 20, durationMin: null, stops: null, airline: null },
      { id: 'only-timed', price: 100, durationMin: 200, stops: 0, airline: 'X' },
    ];
    const result = selectRouteOffers(priced);
    expect(result.cheapest.id).toBe('cheap-no-duration');
    expect(result.fastest.id).toBe('only-timed');
    expect(result.bestValue.id).toBe('only-timed');
  });

  test('a single offer wins all three categories', () => {
    const priced = [{ id: 'only', price: 75, durationMin: 120, stops: 0, airline: 'Z' }];
    const result = selectRouteOffers(priced);
    expect(result.cheapest.id).toBe('only');
    expect(result.fastest.id).toBe('only');
    expect(result.bestValue.id).toBe('only');
  });
});

// [ROUTE-REFRESH-TIER] warmRoutePricesOnce() — the proactive background
// warming cycle that now reads each route's own refresh_frequency
// instead of applying one blanket 12h rule to every published route.
describe('warmRoutePricesOnce', () => {
  const { warmRoutePricesOnce } = require('../src/routes/search.routes');
  const DUFFEL_OFFER = { data: { id: 'orq_w', offers: [{ id: 'off_w', total_amount: '150.00', total_currency: 'EUR', slices: [{ duration: 'PT3H', segments: [{ marketing_carrier: { name: 'Airpiv Air' } }] }] }] } };
  const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

  test("excludes refresh_frequency='none' routes entirely, even with no cache at all", async () => {
    supa.__setResponse('route_pages', { result: { data: [{ origin_iata: 'BER', destination_iata: 'FRA', refresh_frequency: 'none' }], error: null } });
    mockGetAdminConfig.mockResolvedValue(null); // "never cached" — would be due under any threshold
    mockDuffelFn.mockResolvedValue(DUFFEL_OFFER);
    await warmRoutePricesOnce();
    expect(mockDuffelFn).not.toHaveBeenCalled();
  });

  test("warms a '6h' route whose cache is 7h old — stale relative to its OWN threshold, not the old blanket 12h", async () => {
    supa.__setResponse('route_pages', { result: { data: [{ origin_iata: 'MUC', destination_iata: 'PMI', refresh_frequency: '6h' }], error: null } });
    mockGetAdminConfig.mockResolvedValue({ price: 80, fetchedAt: hoursAgo(7) });
    mockDuffelFn.mockResolvedValue(DUFFEL_OFFER);
    await warmRoutePricesOnce();
    expect(mockDuffelFn).toHaveBeenCalled();
    expect(mockSetAdminConfig).toHaveBeenCalledWith('route_price_MUC_PMI', expect.any(Object));
  });

  test("does NOT warm a '24h' route whose cache is only 7h old — still fresh relative to its own threshold", async () => {
    supa.__setResponse('route_pages', { result: { data: [{ origin_iata: 'HAM', destination_iata: 'LIS', refresh_frequency: '24h' }], error: null } });
    mockGetAdminConfig.mockResolvedValue({ price: 80, fetchedAt: hoursAgo(7) });
    mockDuffelFn.mockResolvedValue(DUFFEL_OFFER);
    await warmRoutePricesOnce();
    expect(mockDuffelFn).not.toHaveBeenCalled();
  });

  test('duplicate IATA pairs at different frequencies pick the shortest interval (never under-serves either row)', async () => {
    supa.__setResponse('route_pages', {
      result: {
        data: [
          { origin_iata: 'DUS', destination_iata: 'AGP', refresh_frequency: '24h' },
          { origin_iata: 'DUS', destination_iata: 'AGP', refresh_frequency: '6h' },
        ],
        error: null,
      },
    });
    // 7h-old cache: stale for the 6h row, still fresh for the 24h row —
    // the pair must be treated as due, proving the shortest wins.
    mockGetAdminConfig.mockResolvedValue({ price: 80, fetchedAt: hoursAgo(7) });
    mockDuffelFn.mockResolvedValue(DUFFEL_OFFER);
    await warmRoutePricesOnce();
    expect(mockDuffelFn).toHaveBeenCalledTimes(1); // de-duped to ONE warm, not two
  });
});

describe('GET /search/airports', () => {
  test('returns an empty list for a too-short query without calling Duffel', async () => {
    const res = await request(app).get('/search/airports?q=b');
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
    const res = await request(app).get('/search/airports?q=munich');
    expect(res.status).toBe(200);
    expect(res.body.airports).toHaveLength(2);
    expect(res.body.airports.map((a) => a.type).sort()).toEqual(['airport', 'city']);
  });

  test('a repeated identical query within the cache window is served from cache', async () => {
    mockDuffelFn.mockResolvedValue({ data: [{ type: 'airport', iata_code: 'CDG', name: 'Charles de Gaulle', city_name: 'Paris', iata_country_code: 'FR' }] });
    await request(app).get('/search/airports?q=paris-unique-1');
    await request(app).get('/search/airports?q=paris-unique-1');
    expect(mockDuffelFn).toHaveBeenCalledTimes(1);
  });

  test('a Duffel failure surfaces as an error response', async () => {
    const err = new Error('places API down'); err.status = 502;
    mockDuffelFn.mockRejectedValue(err);
    const res = await request(app).get('/search/airports?q=unique-fail-query');
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
  });
});

describe('GET /debug/raw', () => {
  test('requires admin auth', async () => {
    const res = await request(app).get('/debug/raw?origin=BER&destination=ORD&departure_date=2026-06-25');
    expect(res.status).toBe(401);
  });

  test('requires origin/destination/departure_date when authorized', async () => {
    const res = await request(app).get('/debug/raw').set('Authorization', 'Bearer test-admin-token');
    expect(res.status).toBe(400);
  });

  test('returns a fare summary when authorized with valid params', async () => {
    mockDuffelFn.mockResolvedValue({ data: { offers: [{ total_amount: '77.00', slices: [{ segments: [{ passengers: [{ cabin_class: 'economy' }] }] }] }] } });
    const res = await request(app).get('/debug/raw?origin=BER&destination=ORD&departure_date=2026-06-25')
      .set('Authorization', 'Bearer test-admin-token');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.total_offers).toBe(1);
  });
});
