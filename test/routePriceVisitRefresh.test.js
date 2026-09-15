process.env.DUFFEL_TOKEN = 'test-token';

const mockFetchAndCacheRoutePrice = jest.fn();
const mockIsPublishedRoute = jest.fn().mockResolvedValue(true);
const mockLogSearchAccess = jest.fn();

jest.mock('../src/routes/search.routes', () => ({
  fetchAndCacheRoutePrice: (...args) => mockFetchAndCacheRoutePrice(...args),
  isPublishedRoute: (...args) => mockIsPublishedRoute(...args),
}));

jest.mock('../src/services/adminConfig', () => ({
  getAdminConfig: jest.fn().mockResolvedValue(null),
}));

jest.mock('../src/middleware/rateLimit', () => () => (req, res, next) => next());

jest.mock('../src/middleware/searchGuard', () => ({
  clientIp: () => '127.0.0.1',
  logSearchAccess: (...args) => mockLogSearchAccess(...args),
}));

jest.mock('../src/config/price', () => ({
  PRICE_FRESHNESS_MS: 24 * 60 * 60 * 1000,
  buildPriceSnapshot: (value) => value,
}));

const express = require('express');
const request = require('supertest');
const registerRoutePriceVisitRefresh = require('../src/middleware/routePriceVisitRefresh');

function buildApp() {
  const app = express();
  app.use(express.json());
  registerRoutePriceVisitRefresh(app);
  app.get('/route-price', (req, res) => res.json({ ok: true, cacheOnly: true }));
  return app;
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  mockFetchAndCacheRoutePrice.mockReset();
  mockIsPublishedRoute.mockClear();
  mockLogSearchAccess.mockClear();
  mockIsPublishedRoute.mockResolvedValue(true);
  mockFetchAndCacheRoutePrice.mockResolvedValue({
    ok: true,
    price: 99,
    currency: 'EUR',
    cached: false,
    snapshot: { source: 'live' },
  });
});

describe('route-price user-visit refresh', () => {
  test('crawler gets cache-only path and never triggers Duffel refresh', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/route-price?from=DUS&to=BER')
      .set('user-agent', 'Googlebot/2.1 (+http://www.google.com/bot.html)')
      .set('accept', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body.cacheOnly).toBe(true);
    expect(mockFetchAndCacheRoutePrice).not.toHaveBeenCalled();
  });

  test('normal browser fetch triggers one live refresh and returns its result', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/route-price?from=DUS&to=BER')
      .set('user-agent', 'Mozilla/5.0')
      .set('sec-fetch-mode', 'cors')
      .set('sec-fetch-dest', 'empty')
      .set('accept', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ price: 99, cached: false }));
    expect(mockFetchAndCacheRoutePrice).toHaveBeenCalledTimes(1);
    expect(mockFetchAndCacheRoutePrice).toHaveBeenCalledWith('DUS', 'BER', 21, 'route_price_DUS_BER');
  });

  test('concurrent real visitors share one in-flight Duffel refresh', async () => {
    const app = buildApp();
    let resolveRefresh;
    mockFetchAndCacheRoutePrice.mockImplementation(() => new Promise((resolve) => {
      resolveRefresh = resolve;
    }));

    const headers = {
      'user-agent': 'Mozilla/5.0',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      accept: 'application/json',
    };
    const first = request(app).get('/route-price?from=DUS&to=BER').set(headers);
    await waitFor(() => mockFetchAndCacheRoutePrice.mock.calls.length === 1);
    const second = request(app).get('/route-price?from=DUS&to=BER').set(headers);
    await waitFor(() => mockFetchAndCacheRoutePrice.mock.calls.length === 1 && typeof resolveRefresh === 'function');

    expect(mockFetchAndCacheRoutePrice).toHaveBeenCalledTimes(1);

    resolveRefresh({ ok: true, price: 88, currency: 'EUR', cached: false, snapshot: { source: 'live' } });
    const [a, b] = await Promise.all([first, second]);
    expect(a.body.price).toBe(88);
    expect(b.body.price).toBe(88);
  });
});
