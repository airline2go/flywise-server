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
      upsert: () => builder,
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
  refunds: { create: jest.fn().mockResolvedValue({}) },
  checkout: { sessions: { create: jest.fn(), retrieve: jest.fn() } },
}));

jest.mock('../src/utils/log', () => jest.fn());
jest.mock('../src/clients/sentry', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));

jest.mock('../src/services/adminConfig', () => ({
  recordSyncFailureEvent: jest.fn(),
}));

jest.mock('../src/services/pendingBookings', () => ({
  rememberBooking: jest.fn().mockResolvedValue(true),
  getPendingBooking: jest.fn(),
}));

const mockDuffelFn = jest.fn();
jest.mock('../src/services/duffel', () => {
  const fn = (...args) => mockDuffelFn(...args);
  return fn;
});

const express = require('express');
const request = require('supertest');
const supa = require('../src/clients/supabase');
const stripe = require('../src/clients/stripe');
const pendingBookings = require('../src/services/pendingBookings');

function buildApp() {
  const app = express();
  app.use(express.json());
  require('../src/routes/flight-change.routes')(app);
  return app;
}

function authAs(userId) {
  supa.__mockGetUser.mockResolvedValue({ data: { user: { id: userId, email: null } }, error: null });
  return { Authorization: 'Bearer valid-token' };
}

let ipCounter = 0;
function nextIp() { ipCounter += 1; return '10.2.0.' + ipCounter; }

// Duffel's raw order shape, minimal fields this route actually reads.
function mockOrder(overrides) {
  return Object.assign({
    id: 'ord_1',
    slices: [
      {
        id: 'sli_out',
        segments: [{
          origin: { iata_code: 'BER' },
          destination: { iata_code: 'CDG' },
          departing_at: '2026-08-01T10:00:00Z',
          passengers: [{ cabin_class: 'economy' }],
        }],
      },
      {
        id: 'sli_ret',
        segments: [{
          origin: { iata_code: 'CDG' },
          destination: { iata_code: 'BER' },
          departing_at: '2026-08-10T10:00:00Z',
          passengers: [{ cabin_class: 'economy' }],
        }],
      },
    ],
  }, overrides);
}

const FUTURE_DATE = '2026-09-01';

beforeEach(() => {
  supa.__reset();
  supa.from.mockClear();
  supa.__mockGetUser.mockReset().mockResolvedValue({ data: null, error: { message: 'invalid token' } });
  mockDuffelFn.mockReset();
  stripe.refunds.create.mockClear().mockResolvedValue({});
  stripe.checkout.sessions.create.mockReset();
  stripe.checkout.sessions.retrieve.mockReset();
  pendingBookings.rememberBooking.mockClear().mockResolvedValue(true);
  pendingBookings.getPendingBooking.mockReset();
});

describe('POST /change-quote', () => {
  test('rejects a past/invalid date before calling Duffel', async () => {
    const app = buildApp();
    const res = await request(app).post('/change-quote').set('X-Forwarded-For', nextIp())
      .send({ order_id: 'ord_1', slice_id: 'sli_out', new_date: '2020-01-01' });

    expect(res.status).toBe(400);
    expect(mockDuffelFn).not.toHaveBeenCalled();
  });

  test('rejects when the order belongs to a different account (IDOR)', async () => {
    const headers = authAs('attacker');
    supa.__setResponse('bookings', { maybeSingle: { data: { user_id: 'victim' }, error: null } });

    const app = buildApp();
    const res = await request(app).post('/change-quote').set('X-Forwarded-For', nextIp()).set(headers)
      .send({ order_id: 'ord_1', slice_id: 'sli_out', new_date: FUTURE_DATE });

    expect(res.status).toBe(403);
    expect(mockDuffelFn).not.toHaveBeenCalled();
  });

  test('rejects a multi-city booking (3+ slices) as unsupported', async () => {
    supa.__setResponse('bookings', { maybeSingle: { data: null, error: null } });
    mockDuffelFn.mockResolvedValueOnce({
      data: mockOrder({ slices: [mockOrder().slices[0], mockOrder().slices[1], mockOrder().slices[0]] }),
    });

    const app = buildApp();
    const res = await request(app).post('/change-quote').set('X-Forwarded-For', nextIp())
      .send({ order_id: 'ord_1', slice_id: 'sli_out', new_date: FUTURE_DATE });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Support/);
  });

  test('rejects a slice_id that does not match the live order (never trusts the client blindly)', async () => {
    supa.__setResponse('bookings', { maybeSingle: { data: null, error: null } });
    mockDuffelFn.mockResolvedValueOnce({ data: mockOrder() });

    const app = buildApp();
    const res = await request(app).post('/change-quote').set('X-Forwarded-For', nextIp())
      .send({ order_id: 'ord_1', slice_id: 'sli_does_not_exist', new_date: FUTURE_DATE });

    expect(res.status).toBe(400);
    // Only the order fetch should have happened — no order_change_requests call.
    expect(mockDuffelFn).toHaveBeenCalledTimes(1);
  });

  test('rejects when Duffel returns no order_change_offers', async () => {
    supa.__setResponse('bookings', { maybeSingle: { data: null, error: null } });
    mockDuffelFn
      .mockResolvedValueOnce({ data: mockOrder() })
      .mockResolvedValueOnce({ data: { id: 'ocr_1', order_change_offers: [] } });

    const app = buildApp();
    const res = await request(app).post('/change-quote').set('X-Forwarded-For', nextIp())
      .send({ order_id: 'ord_1', slice_id: 'sli_out', new_date: FUTURE_DATE });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/keine Umbuchungsoptionen/);
  });

  test('picks the cheapest offer and stores a quote with the sign-convention fields', async () => {
    supa.__setResponse('bookings', { maybeSingle: { data: null, error: null } });
    mockDuffelFn
      .mockResolvedValueOnce({ data: mockOrder() })
      .mockResolvedValueOnce({
        data: {
          id: 'ocr_1',
          order_change_offers: [
            { id: 'off_expensive', new_total_amount: '200.00', change_total_amount: '80.00', penalty_total_amount: '10.00', new_total_currency: 'EUR', expires_at: '2026-01-02T00:00:00Z', slices: [{ segments: [{ departing_at: '2026-09-01T09:00:00Z' }] }] },
            { id: 'off_cheap', new_total_amount: '150.00', change_total_amount: '30.00', penalty_total_amount: '10.00', new_total_currency: 'EUR', expires_at: '2026-01-02T00:00:00Z', slices: [{ segments: [{ departing_at: '2026-09-01T14:00:00Z' }] }] },
          ],
        },
      });

    const app = buildApp();
    const res = await request(app).post('/change-quote').set('X-Forwarded-For', nextIp())
      .send({ order_id: 'ord_1', slice_id: 'sli_out', slice_index: 0, new_date: FUTURE_DATE });

    expect(res.status).toBe(200);
    expect(res.body.change_total_amount).toBe(30);
    expect(res.body.new_total_amount).toBe(150);
    expect(res.body.quote_token).toEqual(expect.any(String));

    expect(pendingBookings.rememberBooking).toHaveBeenCalledWith(
      'chg_' + res.body.quote_token,
      expect.objectContaining({ order_id: 'ord_1', slice_id: 'sli_out', offer_id: 'off_cheap', change_total_amount: 30, consumed: false })
    );

    // Verifies the actual Duffel request shape: remove the old slice, add
    // the replacement with the same route and the new date only.
    expect(mockDuffelFn).toHaveBeenNthCalledWith(2, 'POST', '/air/order_change_requests', {
      data: {
        order_id: 'ord_1',
        slices: { remove: ['sli_out'], add: [{ origin: 'BER', destination: 'CDG', departure_date: FUTURE_DATE, cabin_class: 'economy' }] },
      },
    });
  });
});

describe('POST /change-confirm — free/refund branch', () => {
  function mockQuote(overrides) {
    pendingBookings.getPendingBooking.mockResolvedValueOnce({
      payload: Object.assign({
        order_id: 'ord_1', slice_id: 'sli_out', change_request_id: 'ocr_1', offer_id: 'off_1',
        change_total_amount: -30, new_total_amount: 90, currency: 'EUR', consumed: false,
      }, overrides),
    });
  }

  test('rejects when change_total_amount is positive (must use /change-pay)', async () => {
    mockQuote({ change_total_amount: 50 });

    const app = buildApp();
    const res = await request(app).post('/change-confirm').set('X-Forwarded-For', nextIp())
      .send({ quote_token: 'tok1', order_id: 'ord_1' });

    expect(res.status).toBe(400);
    expect(mockDuffelFn).not.toHaveBeenCalled();
  });

  test('confirms with Duffel and issues a capped refund when cheaper', async () => {
    mockQuote({ change_total_amount: -30 });
    supa.__setResponse('bookings', { maybeSingle: { data: { duffel_amount: 100, customer_paid: 120, stripe_payment_id: 'pi_1', currency: 'EUR' }, error: null } });
    mockDuffelFn.mockResolvedValueOnce({ data: { id: 'ocr_1' } });

    const app = buildApp();
    const res = await request(app).post('/change-confirm').set('X-Forwarded-For', nextIp())
      .send({ quote_token: 'tok1', order_id: 'ord_1' });

    expect(res.status).toBe(200);
    expect(mockDuffelFn).toHaveBeenCalledWith('POST', '/air/order_change_requests/ocr_1/actions/confirm', {
      data: { payment: { type: 'balance', amount: '0', currency: 'EUR' } },
    });
    expect(stripe.refunds.create).toHaveBeenCalledWith({ payment_intent: 'pi_1', amount: 3000 });
    expect(res.body).toMatchObject({ ok: true, refunded: true, refund_amount: 30 });
  });

  test('refund is capped at what the customer actually paid', async () => {
    mockQuote({ change_total_amount: -500 });
    supa.__setResponse('bookings', { maybeSingle: { data: { duffel_amount: 100, customer_paid: 120, stripe_payment_id: 'pi_1', currency: 'EUR' }, error: null } });
    mockDuffelFn.mockResolvedValueOnce({ data: { id: 'ocr_1' } });

    const app = buildApp();
    const res = await request(app).post('/change-confirm').set('X-Forwarded-For', nextIp())
      .send({ quote_token: 'tok1', order_id: 'ord_1' });

    expect(res.status).toBe(200);
    expect(stripe.refunds.create).toHaveBeenCalledWith({ payment_intent: 'pi_1', amount: 12000 });
    expect(res.body.refund_amount).toBe(120);
  });

  test('a free change (amount 0) confirms with Duffel and never calls Stripe', async () => {
    mockQuote({ change_total_amount: 0 });
    supa.__setResponse('bookings', { maybeSingle: { data: { duffel_amount: 100, customer_paid: 120, stripe_payment_id: 'pi_1', currency: 'EUR' }, error: null } });
    mockDuffelFn.mockResolvedValueOnce({ data: { id: 'ocr_1' } });

    const app = buildApp();
    const res = await request(app).post('/change-confirm').set('X-Forwarded-For', nextIp())
      .send({ quote_token: 'tok1', order_id: 'ord_1' });

    expect(res.status).toBe(200);
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ ok: true, refunded: false, refund_amount: 0 });
  });

  test('idempotency: a second call for an already-consumed quote does not re-confirm or re-refund', async () => {
    mockQuote({ change_total_amount: -30, consumed: true, refund_amount: 30 });

    const app = buildApp();
    const res = await request(app).post('/change-confirm').set('X-Forwarded-For', nextIp())
      .send({ quote_token: 'tok1', order_id: 'ord_1' });

    expect(res.status).toBe(200);
    expect(res.body.already_processed).toBe(true);
    expect(mockDuffelFn).not.toHaveBeenCalled();
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  test('rejects when the order belongs to a different account (IDOR)', async () => {
    const headers = authAs('attacker');
    supa.__setResponse('bookings', { maybeSingle: { data: { user_id: 'victim' }, error: null } });

    const app = buildApp();
    const res = await request(app).post('/change-confirm').set('X-Forwarded-For', nextIp()).set(headers)
      .send({ quote_token: 'tok1', order_id: 'ord_1' });

    expect(res.status).toBe(403);
    expect(mockDuffelFn).not.toHaveBeenCalled();
  });
});

describe('POST /change-pay — customer owes more', () => {
  function mockQuote(overrides) {
    pendingBookings.getPendingBooking.mockResolvedValueOnce({
      payload: Object.assign({
        order_id: 'ord_1', slice_id: 'sli_out', change_request_id: 'ocr_1', offer_id: 'off_1',
        change_total_amount: 80, new_total_amount: 200, currency: 'EUR', consumed: false,
      }, overrides),
    });
  }

  test('rejects when change_total_amount is not positive (must use /change-confirm)', async () => {
    mockQuote({ change_total_amount: 0 });

    const app = buildApp();
    const res = await request(app).post('/change-pay').set('X-Forwarded-For', nextIp())
      .send({ quote_token: 'tok1', order_id: 'ord_1' });

    expect(res.status).toBe(400);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test('creates a Stripe Checkout Session for exactly the quoted delta, no margin', async () => {
    mockQuote({});
    stripe.checkout.sessions.create.mockResolvedValueOnce({ id: 'cs_test123', url: 'https://stripe.example/checkout' });

    const app = buildApp();
    const res = await request(app).post('/change-pay').set('X-Forwarded-For', nextIp())
      .send({ quote_token: 'tok1', order_id: 'ord_1', success_url: 'https://airpiv.com/success' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, url: 'https://stripe.example/checkout', amount: 80, currency: 'EUR' });
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      success_url: 'https://airpiv.com/success?change_session_id={CHECKOUT_SESSION_ID}',
      metadata: { airpiv_flight_change: '1', order_id: 'ord_1' },
    }));
    const call = stripe.checkout.sessions.create.mock.calls[0][0];
    expect(call.line_items[0].price_data.unit_amount).toBe(8000);
  });

  test('rejects when the order belongs to a different account (IDOR)', async () => {
    const headers = authAs('attacker');
    supa.__setResponse('bookings', { maybeSingle: { data: { user_id: 'victim' }, error: null } });

    const app = buildApp();
    const res = await request(app).post('/change-pay').set('X-Forwarded-For', nextIp()).set(headers)
      .send({ quote_token: 'tok1', order_id: 'ord_1' });

    expect(res.status).toBe(403);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

describe('POST /confirm-change-payment', () => {
  function mockPending(overrides) {
    pendingBookings.getPendingBooking.mockResolvedValueOnce({
      payload: Object.assign({
        order_id: 'ord_1', slice_id: 'sli_out', change_request_id: 'ocr_1', offer_id: 'off_1',
        change_total_amount: 80, new_total_amount: 200, currency: 'EUR', consumed: false,
      }, overrides),
    });
  }

  test('rejects a malformed session_id before touching Stripe/Duffel', async () => {
    const app = buildApp();
    const res = await request(app).post('/confirm-change-payment').set('X-Forwarded-For', nextIp())
      .send({ session_id: 'not-a-real-session' });

    expect(res.status).toBe(400);
    expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
    expect(mockDuffelFn).not.toHaveBeenCalled();
  });

  test('rejects when Stripe reports the session as unpaid', async () => {
    mockPending({});
    stripe.checkout.sessions.retrieve.mockResolvedValueOnce({ payment_status: 'unpaid' });

    const app = buildApp();
    const res = await request(app).post('/confirm-change-payment').set('X-Forwarded-For', nextIp())
      .send({ session_id: 'cs_test123' });

    expect(res.status).toBe(402);
    expect(mockDuffelFn).not.toHaveBeenCalled();
  });

  test('confirms the Duffel change at the full owed amount once payment is verified', async () => {
    mockPending({});
    stripe.checkout.sessions.retrieve.mockResolvedValueOnce({ payment_status: 'paid', payment_intent: 'pi_2' });
    mockDuffelFn.mockResolvedValueOnce({ data: { id: 'ocr_1' } });
    supa.__setResponse('bookings', { maybeSingle: { data: { duffel_amount: 100, customer_paid: 120 }, error: null } });

    const app = buildApp();
    const res = await request(app).post('/confirm-change-payment').set('X-Forwarded-For', nextIp())
      .send({ session_id: 'cs_test123' });

    expect(res.status).toBe(200);
    expect(mockDuffelFn).toHaveBeenCalledWith('POST', '/air/order_change_requests/ocr_1/actions/confirm', {
      data: { payment: { type: 'balance', amount: '80', currency: 'EUR' } },
    });
    expect(res.body).toMatchObject({ ok: true, order_id: 'ord_1' });
  });

  test('idempotency: a second call for an already-consumed session does not re-confirm with Duffel', async () => {
    mockPending({ consumed: true });

    const app = buildApp();
    const res = await request(app).post('/confirm-change-payment').set('X-Forwarded-For', nextIp())
      .send({ session_id: 'cs_test123' });

    expect(res.status).toBe(200);
    expect(res.body.already_processed).toBe(true);
    expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
    expect(mockDuffelFn).not.toHaveBeenCalled();
  });
});
