jest.mock('../src/clients/supabase', () => {
  const responses = {};
  const mockGetUser = jest.fn();
  function makeBuilder(table) {
    const cfg = responses[table] || {};
    const builder = {
      select: () => builder,
      eq: () => builder,
      update: () => builder,
      maybeSingle: () => Promise.resolve(cfg.maybeSingle || { data: null, error: null }),
      then: (resolve, reject) => Promise.resolve(cfg.result || { data: null, error: null }).then(resolve, reject),
    };
    return builder;
  }
  return {
    from: jest.fn((table) => makeBuilder(table)),
    auth: { getUser: mockGetUser },
    __mockGetUser: mockGetUser,
    __setResponse: (table, cfg) => { responses[table] = cfg; },
    __reset: () => { for (const k of Object.keys(responses)) delete responses[k]; },
  };
});

const mockGetLoyaltyConfig = jest.fn();
const mockGetOrCreateLoyaltyAccount = jest.fn();
const mockLogLoyaltyTransaction = jest.fn();
jest.mock('../src/services/loyalty', () => ({
  getLoyaltyConfig: (...args) => mockGetLoyaltyConfig(...args),
  getOrCreateLoyaltyAccount: (...args) => mockGetOrCreateLoyaltyAccount(...args),
  logLoyaltyTransaction: (...args) => mockLogLoyaltyTransaction(...args),
}));

jest.mock('../src/utils/log', () => jest.fn());

const express = require('express');
const request = require('supertest');
const supa = require('../src/clients/supabase');

function buildApp() {
  const app = express();
  app.use(express.json());
  require('../src/routes/loyalty.routes')(app);
  return app;
}

const app = buildApp();

function authAs(userId) {
  supa.__mockGetUser.mockResolvedValue({ data: { user: { id: userId, email: 'x@y.com' } }, error: null });
  return { Authorization: 'Bearer valid-token' };
}

beforeEach(() => {
  supa.__reset();
  supa.from.mockClear();
  supa.__mockGetUser.mockReset().mockResolvedValue({ data: null, error: { message: 'invalid token' } });
  mockGetLoyaltyConfig.mockReset().mockResolvedValue({ pointsPerEuroRedeem: 400 });
  mockGetOrCreateLoyaltyAccount.mockReset();
  mockLogLoyaltyTransaction.mockReset();
});

describe('POST /loyalty/redeem', () => {
  test('401s for a request with no/invalid token', async () => {
    const res = await request(app).post('/loyalty/redeem').send({ points: 400 });
    expect(res.status).toBe(401);
  });

  test('rejects a zero/negative/missing points value', async () => {
    const headers = authAs('user-1');
    for (const points of [0, -100, undefined]) {
      const res = await request(app).post('/loyalty/redeem').set(headers).send({ points });
      expect(res.status).toBe(400);
    }
  });

  test('rejects a points value that is not a multiple of the configured rate', async () => {
    const headers = authAs('user-2');
    mockGetOrCreateLoyaltyAccount.mockResolvedValue({ points: 1000, credit: 0 });
    const res = await request(app).post('/loyalty/redeem').set(headers).send({ points: 150 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/400/);
  });

  test('500s when the loyalty account cannot be found', async () => {
    const headers = authAs('user-3');
    mockGetOrCreateLoyaltyAccount.mockResolvedValue(null);
    const res = await request(app).post('/loyalty/redeem').set(headers).send({ points: 400 });
    expect(res.status).toBe(500);
  });

  test('rejects redeeming more points than the account has', async () => {
    const headers = authAs('user-4');
    mockGetOrCreateLoyaltyAccount.mockResolvedValue({ points: 300, credit: 0 });
    const res = await request(app).post('/loyalty/redeem').set(headers).send({ points: 400 });
    expect(res.status).toBe(400);
    expect(res.body.available_points).toBe(300);
  });

  test('a valid redemption converts points to credit correctly and persists it', async () => {
    const headers = authAs('user-5');
    mockGetOrCreateLoyaltyAccount.mockResolvedValue({ points: 1200, credit: 5 });
    supa.__setResponse('loyalty_accounts', {
      maybeSingle: { data: { credit: 8, points: 800, lifetime_points: 1500, tier: 'silver' }, error: null },
    });
    const res = await request(app).post('/loyalty/redeem').set(headers).send({ points: 400 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      redeemed_points: 400,
      redeemed_euros: 1,
      loyalty: { credit: 8, points: 800, lifetime_points: 1500, tier: 'silver' },
    });
    expect(supa.from).toHaveBeenCalledWith('loyalty_accounts');
    // [LEDGER] Every credit-adding path must also log a loyalty_transactions
    // row — additive on top of the balance mutation itself.
    expect(mockLogLoyaltyTransaction).toHaveBeenCalledWith('user', 'user-5', 'reward', 1, 6, expect.any(String));
  });

  test('lifetime_points falls back to points on the updated row when null', async () => {
    const headers = authAs('user-6');
    mockGetOrCreateLoyaltyAccount.mockResolvedValue({ points: 400, credit: 0 });
    supa.__setResponse('loyalty_accounts', {
      maybeSingle: { data: { credit: 1, points: 0, lifetime_points: null, tier: 'bronze' }, error: null },
    });
    const res = await request(app).post('/loyalty/redeem').set(headers).send({ points: 400 });
    expect(res.status).toBe(200);
    expect(res.body.loyalty.lifetime_points).toBe(0);
  });

  test('surfaces a database update failure as a 500', async () => {
    const headers = authAs('user-7');
    mockGetOrCreateLoyaltyAccount.mockResolvedValue({ points: 400, credit: 0 });
    supa.__setResponse('loyalty_accounts', { maybeSingle: { data: null, error: { message: 'connection lost' } } });
    const res = await request(app).post('/loyalty/redeem').set(headers).send({ points: 400 });
    expect(res.status).toBe(500);
  });

  test('respects a custom pointsPerEuroRedeem from config', async () => {
    const headers = authAs('user-8');
    mockGetLoyaltyConfig.mockResolvedValue({ pointsPerEuroRedeem: 100 });
    mockGetOrCreateLoyaltyAccount.mockResolvedValue({ points: 500, credit: 0 });
    supa.__setResponse('loyalty_accounts', {
      maybeSingle: { data: { credit: 3, points: 200, lifetime_points: 200, tier: 'bronze' }, error: null },
    });
    const res = await request(app).post('/loyalty/redeem').set(headers).send({ points: 300 });
    expect(res.status).toBe(200);
    expect(res.body.redeemed_euros).toBe(3);
  });
});

describe('GET /loyalty/config', () => {
  test('returns the loyalty config', async () => {
    mockGetLoyaltyConfig.mockResolvedValue({ pointsPerEuroRedeem: 400, pointsPerEuroEarn: 10 });
    const res = await request(app).get('/loyalty/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, config: { pointsPerEuroRedeem: 400, pointsPerEuroEarn: 10 } });
  });

  test('surfaces an error as a 500', async () => {
    mockGetLoyaltyConfig.mockRejectedValue(new Error('config load failed'));
    const res = await request(app).get('/loyalty/config');
    expect(res.status).toBe(500);
  });
});
