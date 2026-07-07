jest.mock('../src/clients/supabase', () => {
  const responses = {};
  const mockGetUser = jest.fn();
  function makeBuilder(table) {
    const cfg = responses[table] || {};
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      insert: () => builder,
      update: () => builder,
      delete: () => builder,
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

jest.mock('../src/clients/stripe', () => ({
  checkout: { sessions: { create: jest.fn() } },
}));

jest.mock('../src/utils/log', () => jest.fn());
jest.mock('../src/clients/sentry', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));

const mockDuffelFn = jest.fn();
jest.mock('../src/services/duffel', () => {
  const fn = (...args) => mockDuffelFn(...args);
  fn.getDuffelCircuitStatus = () => ({ state: 'closed', consecutiveFailures: 0 });
  return fn;
});

jest.mock('../src/services/adminConfig', () => ({
  getTicketProfitTiers: jest.fn().mockResolvedValue([]),
  getAncillaryProfitTiers: jest.fn().mockResolvedValue([]),
  computeTieredMargin: jest.fn().mockReturnValue(0),
  recordBookingFailureEvent: jest.fn(),
}));

jest.mock('../src/services/pendingBookings', () => ({
  rememberBooking: jest.fn().mockResolvedValue(true),
  getPendingBooking: jest.fn(),
  setBookingStatus: jest.fn(),
  getBookingStatus: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const supa = require('../src/clients/supabase');
const stripe = require('../src/clients/stripe');

function buildApp() {
  const app = express();
  app.use(express.json());
  require('../src/routes/booking.routes')(app);
  return app;
}

const app = buildApp();

function authAs(userId) {
  supa.__mockGetUser.mockResolvedValue({ data: { user: { id: userId, email: null } }, error: null });
  return { Authorization: 'Bearer valid-token' };
}

let ipCounter = 0;
function nextIp() { ipCounter += 1; return '10.1.0.' + ipCounter; }

beforeEach(() => {
  supa.__reset();
  supa.from.mockClear();
  supa.__mockGetUser.mockReset().mockResolvedValue({ data: null, error: { message: 'invalid token' } });
  mockDuffelFn.mockReset();
  stripe.checkout.sessions.create.mockReset();
});

describe('GET /order/:id — IDOR protection', () => {
  test('rejects when the order belongs to a different account', async () => {
    const headers = authAs('attacker');
    supa.__setResponse('bookings', { maybeSingle: { data: { user_id: 'victim' }, error: null } });

    const res = await request(app).get('/order/ord_1').set(headers).set('X-Forwarded-For', nextIp());

    expect(res.status).toBe(403);
    expect(mockDuffelFn).not.toHaveBeenCalled();
  });

  test('allows the account owner to view their own order', async () => {
    const headers = authAs('owner');
    supa.__setResponse('bookings', { maybeSingle: { data: { user_id: 'owner' }, error: null } });
    mockDuffelFn.mockResolvedValueOnce({ data: { id: 'ord_1', booking_reference: 'REF1' } });

    const res = await request(app).get('/order/ord_1').set(headers).set('X-Forwarded-For', nextIp());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, order: { id: 'ord_1', booking_reference: 'REF1' } });
  });

  test('allows an unauthenticated guest to view a guest order (no user_id) by reference alone', async () => {
    supa.__setResponse('bookings', { maybeSingle: { data: { user_id: null }, error: null } });
    mockDuffelFn.mockResolvedValueOnce({ data: { id: 'ord_1' } });

    const res = await request(app).get('/order/ord_1').set('X-Forwarded-For', nextIp());

    expect(res.status).toBe(200);
  });
});

describe('GET /booking-confirmation — IDOR protection', () => {
  test('requires session_id or order_id', async () => {
    const res = await request(app).get('/booking-confirmation').set('X-Forwarded-For', nextIp());
    expect(res.status).toBe(400);
  });

  test('rejects when the booking belongs to a different account', async () => {
    const headers = authAs('attacker');
    supa.__setResponse('bookings', { maybeSingle: { data: { user_id: 'victim', duffel_order_id: 'ord_1' }, error: null } });

    const res = await request(app).get('/booking-confirmation?order_id=ord_1').set(headers).set('X-Forwarded-For', nextIp());

    expect(res.status).toBe(403);
    expect(mockDuffelFn).not.toHaveBeenCalled();
  });

  test('allows an unauthenticated guest to view a guest booking confirmation by session_id', async () => {
    supa.__setResponse('bookings', { maybeSingle: { data: { user_id: null, duffel_order_id: 'ord_1', booking_reference: 'REF1' }, error: null } });
    mockDuffelFn.mockResolvedValueOnce({ data: { id: 'ord_1' } });

    const res = await request(app).get('/booking-confirmation?session_id=cs_test').set('X-Forwarded-For', nextIp());

    expect(res.status).toBe(200);
    expect(res.body.booking.reference).toBe('REF1');
  });

  test('allows the account owner to view their own booking confirmation', async () => {
    const headers = authAs('owner');
    supa.__setResponse('bookings', { maybeSingle: { data: { user_id: 'owner', duffel_order_id: 'ord_1', booking_reference: 'REF1' }, error: null } });
    mockDuffelFn.mockResolvedValueOnce({ data: { id: 'ord_1' } });

    const res = await request(app).get('/booking-confirmation?order_id=ord_1').set(headers).set('X-Forwarded-For', nextIp());

    expect(res.status).toBe(200);
  });
});

describe('POST /add-services — IDOR protection', () => {
  test('rejects when the order belongs to a different account, before any Duffel/Stripe call', async () => {
    const headers = authAs('attacker');
    supa.__setResponse('bookings', { maybeSingle: { data: { user_id: 'victim' }, error: null } });

    const res = await request(app).post('/add-services').set(headers).set('X-Forwarded-For', nextIp())
      .send({ order_id: 'ord_1', services: [{ id: 'svc_1' }] });

    expect(res.status).toBe(403);
    expect(mockDuffelFn).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test('proceeds past the ownership check for the account owner (reaches Duffel)', async () => {
    const headers = authAs('owner');
    supa.__setResponse('bookings', { maybeSingle: { data: { user_id: 'owner' }, error: null } });
    mockDuffelFn.mockResolvedValueOnce({ data: null }); // order fetch returns nothing -> 404 further down, but proves the gate passed

    const res = await request(app).post('/add-services').set(headers).set('X-Forwarded-For', nextIp())
      .send({ order_id: 'ord_1', services: [{ id: 'svc_1' }] });

    expect(res.status).toBe(404);
    expect(mockDuffelFn).toHaveBeenCalled();
  });

  test('proceeds past the ownership check for an unauthenticated guest (guest booking, no user_id)', async () => {
    supa.__setResponse('bookings', { maybeSingle: { data: { user_id: null }, error: null } });
    mockDuffelFn.mockResolvedValueOnce({ data: null });

    const res = await request(app).post('/add-services').set('X-Forwarded-For', nextIp())
      .send({ order_id: 'ord_1', services: [{ id: 'svc_1' }] });

    expect(res.status).toBe(404);
    expect(mockDuffelFn).toHaveBeenCalled();
  });
});
