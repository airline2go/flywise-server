jest.mock('../src/clients/supabase', () => {
  const responses = {};
  const mockGetUser = jest.fn();
  const mockRpc = jest.fn();
  function makeBuilder(table) {
    const cfg = responses[table] || {};
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      then: (resolve, reject) => Promise.resolve(cfg.result || { data: null, error: null }).then(resolve, reject),
    };
    return builder;
  }
  return {
    from: jest.fn((table) => makeBuilder(table)),
    auth: { getUser: mockGetUser },
    rpc: (...args) => mockRpc(...args),
    __mockGetUser: mockGetUser,
    __mockRpc: mockRpc,
    __setResponse: (table, cfg) => { responses[table] = cfg; },
    __reset: () => { for (const k of Object.keys(responses)) delete responses[k]; },
  };
});

const mockGetOrCreateLoyaltyAccount = jest.fn();
jest.mock('../src/services/loyalty', () => ({
  getOrCreateLoyaltyAccount: (...args) => mockGetOrCreateLoyaltyAccount(...args),
}));

jest.mock('../src/utils/log', () => jest.fn());

const express = require('express');
const request = require('supertest');
const supa = require('../src/clients/supabase');

function buildApp() {
  const app = express();
  app.use(express.json());
  require('../src/routes/auth.routes')(app);
  return app;
}

const app = buildApp();

function authAs(userId, email) {
  supa.__mockGetUser.mockResolvedValue({ data: { user: { id: userId, email: email || null } }, error: null });
  return { Authorization: 'Bearer valid-token' };
}

beforeEach(() => {
  supa.__reset();
  supa.from.mockClear();
  supa.__mockGetUser.mockReset().mockResolvedValue({ data: null, error: { message: 'invalid token' } });
  supa.__mockRpc.mockReset();
  mockGetOrCreateLoyaltyAccount.mockReset();
});

describe('GET /auth/me', () => {
  test('401s for a request with no/invalid token', async () => {
    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(401);
  });

  test('returns loyalty info for an authenticated user, falling back lifetime_points to points', async () => {
    const headers = authAs('user-1', 'a@b.com');
    mockGetOrCreateLoyaltyAccount.mockResolvedValue({ credit: 10, points: 50, lifetime_points: null, tier: 'bronze' });
    const res = await request(app).get('/auth/me').set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      userId: 'user-1',
      loyalty: { credit: 10, points: 50, lifetime_points: 50, tier: 'bronze' },
    });
  });

  test('returns loyalty: null when no loyalty account exists', async () => {
    const headers = authAs('user-2', 'c@d.com');
    mockGetOrCreateLoyaltyAccount.mockResolvedValue(null);
    const res = await request(app).get('/auth/me').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.loyalty).toBeNull();
  });
});

describe('POST /auth/link-guest-bookings', () => {
  test('401s for a request with no/invalid token', async () => {
    const res = await request(app).post('/auth/link-guest-bookings');
    expect(res.status).toBe(401);
  });

  test('returns an empty linked list when the account has no verified email', async () => {
    const headers = authAs('user-3', null);
    const res = await request(app).post('/auth/link-guest-bookings').set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, linked: [] });
    expect(supa.__mockRpc).not.toHaveBeenCalled();
  });

  test('links guest bookings matching the verified email and maps the fields', async () => {
    const headers = authAs('user-4', 'guest@example.com');
    supa.__mockRpc.mockResolvedValue({
      data: [{ booking_reference: 'ABC123', route_label: 'BER-CDG', created_at: '2026-01-01T00:00:00Z', customer_paid: '150.50', currency: 'EUR' }],
      error: null,
    });
    const res = await request(app).post('/auth/link-guest-bookings').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.linked).toEqual([{
      bookingReference: 'ABC123', routeLabel: 'BER-CDG', createdAt: '2026-01-01T00:00:00Z', customerPaid: 150.5, currency: 'EUR',
    }]);
    expect(supa.__mockRpc).toHaveBeenCalledWith('link_guest_bookings_to_user', { p_user_id: 'user-4', p_email: 'guest@example.com' });
  });

  test('surfaces an RPC failure as a 500', async () => {
    const headers = authAs('user-5', 'e@f.com');
    supa.__mockRpc.mockResolvedValue({ data: null, error: { message: 'rpc exploded' } });
    const res = await request(app).post('/auth/link-guest-bookings').set(headers);
    expect(res.status).toBe(500);
  });
});

describe('GET /my-bookings', () => {
  test('401s for a request with no/invalid token', async () => {
    const res = await request(app).get('/my-bookings');
    expect(res.status).toBe(401);
  });

  test("returns only the authenticated user's bookings with mapped field names", async () => {
    const headers = authAs('user-6', 'g@h.com');
    supa.__setResponse('bookings', {
      result: {
        data: [{ booking_reference: 'XYZ789', duffel_order_id: 'ord_1', route_label: 'FRA-JFK', status: 'confirmed', currency: 'USD', customer_paid: '499.99', created_at: '2026-02-01T00:00:00Z' }],
        error: null,
      },
    });
    const res = await request(app).get('/my-bookings').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.bookings).toEqual([{
      bookingReference: 'XYZ789', orderId: 'ord_1', routeLabel: 'FRA-JFK', status: 'confirmed', currency: 'USD', customerPaid: 499.99, createdAt: '2026-02-01T00:00:00Z',
    }]);
    expect(supa.from).toHaveBeenCalledWith('bookings');
  });

  test('returns an empty list rather than an error when the user has no bookings', async () => {
    const headers = authAs('user-7', 'i@j.com');
    supa.__setResponse('bookings', { result: { data: null, error: null } });
    const res = await request(app).get('/my-bookings').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.bookings).toEqual([]);
  });

  test('surfaces a database error as a 500', async () => {
    const headers = authAs('user-8', 'k@l.com');
    supa.__setResponse('bookings', { result: { data: null, error: { message: 'connection lost' } } });
    const res = await request(app).get('/my-bookings').set(headers);
    expect(res.status).toBe(500);
  });
});
