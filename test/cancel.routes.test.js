jest.mock('../src/clients/supabase', () => {
  const responses = {}; // table -> { maybeSingle: {data,error}, result: {data,error} }
  const mockGetUser = jest.fn();
  function makeBuilder(table) {
    const cfg = responses[table] || {};
    const builder = {
      select: () => builder,
      eq: () => builder,
      update: () => builder,
      insert: () => builder,
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
}));

jest.mock('../src/utils/log', () => jest.fn());

const mockDuffelFn = jest.fn();
jest.mock('../src/services/duffel', () => {
  const fn = (...args) => mockDuffelFn(...args);
  return fn;
});

const express = require('express');
const request = require('supertest');
const supa = require('../src/clients/supabase');
const stripe = require('../src/clients/stripe');

function buildApp() {
  const app = express();
  app.use(express.json());
  require('../src/routes/cancel.routes')(app);
  return app;
}

function authAs(userId) {
  supa.__mockGetUser.mockResolvedValue({ data: { user: { id: userId, email: null } }, error: null });
  return { Authorization: 'Bearer valid-token' };
}

beforeEach(() => {
  supa.__reset();
  supa.from.mockClear();
  supa.__mockGetUser.mockReset().mockResolvedValue({ data: null, error: { message: 'invalid token' } });
  stripe.refunds.create.mockClear();
  stripe.refunds.create.mockResolvedValue({});
  mockDuffelFn.mockReset();
});

describe('POST /cancel-quote — refund breakdown math', () => {
  test('computes airline fee, service fee and final refund from the real booking row', async () => {
    mockDuffelFn.mockResolvedValueOnce({
      data: { id: 'cxl_1', refund_amount: '80.00', refund_currency: 'EUR', expires_at: '2026-01-01T00:00:00Z' },
    });
    supa.__setResponse('bookings', { maybeSingle: { data: { duffel_amount: 100, customer_paid: 120, currency: 'EUR' }, error: null } });

    const app = buildApp();
    const res = await request(app).post('/cancel-quote').set('X-Forwarded-For', '10.0.0.1').send({ order_id: 'ord_1' });

    expect(res.status).toBe(200);
    expect(res.body.breakdown).toEqual({
      ticket_price: 120,
      airline_fee: 20,
      airpiv_service_fee: 20,
      final_refund_amount: 80,
      currency: 'EUR',
    });
  });
});

describe('POST /cancel-confirm — proportional Stripe refund', () => {
  function mockBookingRow(overrides) {
    supa.__setResponse('bookings', {
      maybeSingle: {
        data: Object.assign({
          duffel_amount: 100,
          customer_paid: 120,
          stripe_payment_id: 'pi_1',
          currency: 'EUR',
          user_id: null,
          loyalty_discount: 0,
          loyalty_points_earned: 0,
          customer_email: null,
          booking_reference: 'REF1',
          route_label: 'BER-CDG',
        }, overrides),
        error: null,
      },
      result: { data: null, error: null }, // used by the fire-and-forget status update
    });
  }

  test('issues a proportional refund matching the ratio Duffel actually granted', async () => {
    mockDuffelFn.mockResolvedValueOnce({
      data: { order_id: 'ord_1', refund_amount: '50.00', refund_currency: 'EUR' },
    });
    mockBookingRow({});

    const app = buildApp();
    const res = await request(app).post('/cancel-confirm').set('X-Forwarded-For', '10.0.0.2').send({ cancellation_id: 'cxl_1', order_id: 'ord_1' });

    expect(res.status).toBe(200);
    // refundRatio = 50/100 = 0.5; actualRefundToCustomer = min(50, 120) = 50
    expect(stripe.refunds.create).toHaveBeenCalledWith({ payment_intent: 'pi_1', amount: 5000 });
    expect(res.body).toMatchObject({
      ok: true,
      cancelled: true,
      refund_amount: 50,
      stripe_refund_issued: true,
      stripe_refund_error: null,
    });
    expect(res.body.breakdown).toEqual({
      ticket_price: 120,
      airline_fee: 50,
      airpiv_service_fee: 20,
      final_refund_amount: 50,
      currency: 'EUR',
    });
  });

  test('a non-refundable fare (Duffel refund_amount 0) never calls Stripe', async () => {
    mockDuffelFn.mockResolvedValueOnce({
      data: { order_id: 'ord_1', refund_amount: '0', refund_currency: 'EUR' },
    });
    mockBookingRow({});

    const app = buildApp();
    const res = await request(app).post('/cancel-confirm').set('X-Forwarded-For', '10.0.0.3').send({ cancellation_id: 'cxl_1', order_id: 'ord_1' });

    expect(res.status).toBe(200);
    expect(stripe.refunds.create).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ ok: true, refund_amount: 0, stripe_refund_issued: false });
  });

  test('a full refund never exceeds what the customer actually paid', async () => {
    // Duffel somehow reports a refund larger than duffel_amount (shouldn't normally
    // happen, but the safety cap must hold regardless).
    mockDuffelFn.mockResolvedValueOnce({
      data: { order_id: 'ord_1', refund_amount: '999.00', refund_currency: 'EUR' },
    });
    mockBookingRow({ duffel_amount: 100, customer_paid: 120 });

    const app = buildApp();
    const res = await request(app).post('/cancel-confirm').set('X-Forwarded-For', '10.0.0.4').send({ cancellation_id: 'cxl_1', order_id: 'ord_1' });

    expect(res.status).toBe(200);
    expect(stripe.refunds.create).toHaveBeenCalledWith({ payment_intent: 'pi_1', amount: 12000 });
    expect(res.body.refund_amount).toBe(120);
  });

  test('a failed Stripe refund is reported via stripe_refund_error without crashing the request', async () => {
    mockDuffelFn.mockResolvedValueOnce({
      data: { order_id: 'ord_1', refund_amount: '50.00', refund_currency: 'EUR' },
    });
    mockBookingRow({});
    stripe.refunds.create.mockRejectedValueOnce(new Error('card_declined'));

    const app = buildApp();
    const res = await request(app).post('/cancel-confirm').set('X-Forwarded-For', '10.0.0.5').send({ cancellation_id: 'cxl_1', order_id: 'ord_1' });

    expect(res.status).toBe(200);
    expect(res.body.stripe_refund_issued).toBe(false);
    expect(res.body.stripe_refund_error).toBe('card_declined');
  });

  test('missing cancellation_id is rejected before any Duffel/Stripe call', async () => {
    const app = buildApp();
    const res = await request(app).post('/cancel-confirm').set('X-Forwarded-For', '10.0.0.6').send({});

    expect(res.status).toBe(400);
    expect(mockDuffelFn).not.toHaveBeenCalled();
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  test('missing order_id is rejected before any Duffel/Stripe call', async () => {
    const app = buildApp();
    const res = await request(app).post('/cancel-confirm').set('X-Forwarded-For', '10.0.0.7').send({ cancellation_id: 'cxl_1' });

    expect(res.status).toBe(400);
    expect(mockDuffelFn).not.toHaveBeenCalled();
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });
});

describe('IDOR protection — a logged-in user cannot act on another account\'s booking', () => {
  test('POST /cancel is rejected when the order belongs to a different account', async () => {
    const headers = authAs('attacker');
    supa.__setResponse('bookings', { maybeSingle: { data: { user_id: 'victim' }, error: null } });

    const app = buildApp();
    const res = await request(app).post('/cancel').set('X-Forwarded-For', '10.0.0.8').set(headers).send({ order_id: 'ord_1' });

    expect(res.status).toBe(403);
    expect(mockDuffelFn).not.toHaveBeenCalled();
  });

  test('POST /cancel-quote is rejected when the order belongs to a different account', async () => {
    const headers = authAs('attacker');
    supa.__setResponse('bookings', { maybeSingle: { data: { user_id: 'victim' }, error: null } });

    const app = buildApp();
    const res = await request(app).post('/cancel-quote').set('X-Forwarded-For', '10.0.0.9').set(headers).send({ order_id: 'ord_1' });

    expect(res.status).toBe(403);
    expect(mockDuffelFn).not.toHaveBeenCalled();
  });

  test('POST /cancel-confirm is rejected when the order belongs to a different account (no refund/cancellation executed)', async () => {
    const headers = authAs('attacker');
    supa.__setResponse('bookings', { maybeSingle: { data: { user_id: 'victim' }, error: null } });

    const app = buildApp();
    const res = await request(app).post('/cancel-confirm').set('X-Forwarded-For', '10.0.0.10').set(headers).send({ cancellation_id: 'cxl_1', order_id: 'ord_1' });

    expect(res.status).toBe(403);
    expect(mockDuffelFn).not.toHaveBeenCalled();
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  test('an unauthenticated caller (guest checkout) is still allowed to cancel a guest booking (no user_id)', async () => {
    supa.__setResponse('bookings', { maybeSingle: { data: { user_id: null }, error: null } });
    mockDuffelFn
      .mockResolvedValueOnce({ data: { id: 'cxl_1' } })
      .mockResolvedValueOnce({ data: { refund_amount: null } });

    const app = buildApp();
    const res = await request(app).post('/cancel').set('X-Forwarded-For', '10.0.0.11').send({ order_id: 'ord_1' });

    expect(res.status).toBe(200);
  });

  test('the account owner themself can still cancel their own booking', async () => {
    const headers = authAs('owner');
    supa.__setResponse('bookings', { maybeSingle: { data: { user_id: 'owner' }, error: null } });
    mockDuffelFn
      .mockResolvedValueOnce({ data: { id: 'cxl_1' } })
      .mockResolvedValueOnce({ data: { refund_amount: null } });

    const app = buildApp();
    const res = await request(app).post('/cancel').set('X-Forwarded-For', '10.0.0.12').set(headers).send({ order_id: 'ord_1' });

    expect(res.status).toBe(200);
  });
});
