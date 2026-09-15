process.env.NODE_ENV = 'production';

const mockDuffel = jest.fn();
const mockGetAdminConfig = jest.fn();
const mockSetAdminConfig = jest.fn();
const mockIsPublishedRoute = jest.fn();
const mockLogSearchAccess = jest.fn();

jest.mock('../src/services/duffel', () => mockDuffel);
jest.mock('../src/services/adminConfig', () => ({
  getAdminConfig: (...args) => mockGetAdminConfig(...args),
  setAdminConfig: (...args) => mockSetAdminConfig(...args),
}));
jest.mock('../src/routes/search.routes', () => ({
  isPublishedRoute: (...args) => mockIsPublishedRoute(...args),
}));
jest.mock('../src/middleware/rateLimit', () => () => (req, res, next) => next());
jest.mock('../src/middleware/searchGuard', () => ({
  clientIp: () => '127.0.0.1',
  logSearchAccess: (...args) => mockLogSearchAccess(...args),
}));
jest.mock('../src/config/price', () => ({
  PRICE_FRESHNESS_MS: 24 * 60 * 60 * 1000,
  buildPriceSnapshot: (input) => ({ ...input }),
}));

const { handle } = require('../src/middleware/liveRoutePrice');

function req(overrides = {}) {
  const headers = {
    'user-agent': 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
  };
  return {
    query: { from: 'BER', to: 'ATH' },
    get: (name) => headers[String(name).toLowerCase()],
    ...overrides,
  };
}

function res() {
  return {
    json: jest.fn(),
    status: jest.fn().mockReturnThis(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsPublishedRoute.mockResolvedValue(true);
  mockSetAdminConfig.mockResolvedValue(undefined);
});

describe('live route price visitor refresh policy', () => {
  test('first real visitor with no cached price triggers exactly one Duffel refresh', async () => {
    mockGetAdminConfig.mockResolvedValue(null);
    mockDuffel.mockResolvedValue({ data: {
      offers: [
        { id: 'offer-expensive', total_amount: '125.00', total_currency: 'EUR', slices: [{ duration: 'PT3H' }] },
        { id: 'offer-cheapest', total_amount: '99.00', total_currency: 'EUR', slices: [{ duration: 'PT2H' }] },
      ],
    } });

    const response = res();
    await handle(req(), response, jest.fn());

    expect(mockDuffel).toHaveBeenCalledTimes(1);
    expect(mockDuffel).toHaveBeenCalledWith(
      'POST',
      '/air/offer_requests?return_offers=true&supplier_timeout=8000',
      expect.any(Object),
      null,
      expect.objectContaining({ source: 'route_price_user_visit', trigger: 'route_price_user_visit' }),
    );
    expect(mockSetAdminConfig).toHaveBeenCalledWith(
      'route_price_BER_ATH',
      expect.objectContaining({ price: 99, currency: 'EUR' }),
    );
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ price: 99, currency: 'EUR', cached: false }));
  });

  test('fresh cached price is served to later visitors without another Duffel call', async () => {
    mockGetAdminConfig.mockResolvedValue({
      price: 99,
      currency: 'EUR',
      departure_date: '2026-10-06',
      fetchedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      offersCount: 4,
    });

    const response = res();
    await handle(req(), response, jest.fn());

    expect(mockDuffel).not.toHaveBeenCalled();
    expect(mockSetAdminConfig).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ price: 99, cached: true, stale: false }));
  });

  test('expired price is not refreshed until a real visitor arrives, then only one refresh is shared', async () => {
    mockGetAdminConfig.mockResolvedValue({
      price: 99,
      currency: 'EUR',
      departure_date: '2026-10-06',
      fetchedAt: new Date(Date.now() - (24 * 60 * 60 * 1000 + 1000)).toISOString(),
      offersCount: 4,
    });

    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    mockDuffel.mockReturnValueOnce(pending);

    const response1 = res();
    const response2 = res();
    const p1 = handle(req(), response1, jest.fn());
    const p2 = handle(req(), response2, jest.fn());

    await Promise.resolve();
    expect(mockDuffel).toHaveBeenCalledTimes(1);

    release({ data: {
      offers: [{ id: 'offer-new', total_amount: '87.50', total_currency: 'EUR', slices: [{ duration: 'PT2H30M' }] }],
    } });

    await Promise.all([p1, p2]);
    expect(mockDuffel).toHaveBeenCalledTimes(1);
    expect(mockSetAdminConfig).toHaveBeenCalledTimes(1);
    expect(response1.json).toHaveBeenCalledWith(expect.objectContaining({ price: 87.5 }));
    expect(response2.json).toHaveBeenCalledWith(expect.objectContaining({ price: 87.5 }));
  });

  test('bot/crawler requests never trigger Duffel', async () => {
    mockGetAdminConfig.mockResolvedValue(null);
    const response = res();
    const next = jest.fn();

    await handle(req({
      get: (name) => String(name).toLowerCase() === 'user-agent' ? 'Googlebot/2.1' : (String(name).toLowerCase() === 'sec-fetch-mode' ? '' : ''),
    }), response, next);

    expect(mockDuffel).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('failed refresh preserves the previous cached price', async () => {
    const old = {
      price: 99,
      currency: 'EUR',
      departure_date: '2026-10-06',
      fetchedAt: new Date(Date.now() - (24 * 60 * 60 * 1000 + 1000)).toISOString(),
      offersCount: 4,
    };
    mockGetAdminConfig.mockResolvedValue(old);
    mockDuffel.mockRejectedValue(new Error('Duffel unavailable'));

    const response = res();
    await handle(req(), response, jest.fn());

    expect(mockDuffel).toHaveBeenCalledTimes(1);
    expect(mockSetAdminConfig).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ price: 99, currency: 'EUR', cached: true }));
  });
});
