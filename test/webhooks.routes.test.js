process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
process.env.DUFFEL_WEBHOOK_SECRET = 'duffel_test_secret';
process.env.SENTRY_DSN = 'https://fake@sentry.example/1';

jest.mock('../src/clients/supabase', () => {
  const responses = {};
  function makeBuilder(table) {
    const cfg = responses[table] || {};
    const builder = {
      select: () => builder,
      eq: () => builder,
      update: () => builder,
      insert: () => builder,
      maybeSingle: () => Promise.resolve(cfg.maybeSingle || { data: null, error: null }),
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

const mockConstructEvent = jest.fn();
jest.mock('../src/clients/stripe', () => ({
  webhooks: { constructEvent: (...args) => mockConstructEvent(...args) },
}));

jest.mock('../src/clients/sentry', () => ({ captureException: jest.fn() }));

const mockBookFromSession = jest.fn();
jest.mock('../src/services/booking', () => ({
  bookFromSession: (...args) => mockBookFromSession(...args),
  inFlight: new Set(),
}));

const mockRecordBookingFailureEvent = jest.fn();
jest.mock('../src/services/adminConfig', () => ({
  recordBookingFailureEvent: (...args) => mockRecordBookingFailureEvent(...args),
}));

jest.mock('../src/utils/log', () => jest.fn());

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const supa = require('../src/clients/supabase');
const Sentry = require('../src/clients/sentry');
const { inFlight } = require('../src/services/booking');
const log = require('../src/utils/log');

function buildApp() {
  const app = express();
  require('../src/routes/webhooks.routes')(app);
  return app;
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function signDuffelBody(body, secret) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

beforeEach(() => {
  supa.__reset();
  supa.from.mockClear();
  mockConstructEvent.mockReset();
  mockBookFromSession.mockReset();
  mockRecordBookingFailureEvent.mockReset();
  Sentry.captureException.mockClear();
  inFlight.clear();
  log.mockClear();
});

describe('POST /webhooks/stripe', () => {
  test('rejects an invalid/tampered signature with 400', async () => {
    mockConstructEvent.mockImplementation(() => { throw new Error('signature mismatch'); });
    const app = buildApp();
    const res = await request(app).post('/webhooks/stripe')
      .set('stripe-signature', 'bad-sig')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ foo: 'bar' }));
    expect(res.status).toBe(400);
    expect(mockBookFromSession).not.toHaveBeenCalled();
  });

  test('500s when the webhook secret is not configured', async () => {
    const original = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    let res;
    await jest.isolateModulesAsync(async () => {
      const freshApp = express();
      require('../src/routes/webhooks.routes')(freshApp);
      res = await request(freshApp).post('/webhooks/stripe').send(JSON.stringify({}));
    });
    process.env.STRIPE_WEBHOOK_SECRET = original;
    expect(res.status).toBe(500);
  });

  test('a valid checkout.session.completed event books the session', async () => {
    const session = { id: 'cs_test_1', payment_status: 'paid' };
    mockConstructEvent.mockReturnValue({ type: 'checkout.session.completed', data: { object: session } });
    mockBookFromSession.mockResolvedValue({ order_id: 'ord_1', already: false });
    const app = buildApp();
    const res = await request(app).post('/webhooks/stripe')
      .set('stripe-signature', 'valid-sig')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ any: 'thing' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    await flush();
    expect(mockBookFromSession).toHaveBeenCalledWith('cs_test_1', session);
  });

  test('does not double-book when /confirm-payment is already handling the same session (idempotency)', async () => {
    const session = { id: 'cs_test_2', payment_status: 'paid' };
    inFlight.add('cs_test_2');
    mockConstructEvent.mockReturnValue({ type: 'checkout.session.completed', data: { object: session } });
    const app = buildApp();
    await request(app).post('/webhooks/stripe')
      .set('stripe-signature', 'valid-sig')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ any: 'thing' }));
    await flush();
    expect(mockBookFromSession).not.toHaveBeenCalled();
  });

  test('ignores a checkout.session.completed event that has not actually been paid', async () => {
    const session = { id: 'cs_test_3', payment_status: 'unpaid' };
    mockConstructEvent.mockReturnValue({ type: 'checkout.session.completed', data: { object: session } });
    const app = buildApp();
    await request(app).post('/webhooks/stripe')
      .set('stripe-signature', 'valid-sig')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ any: 'thing' }));
    await flush();
    expect(mockBookFromSession).not.toHaveBeenCalled();
  });

  test('a PRICE_DRIFT booking failure is logged as a warning, not escalated to Sentry', async () => {
    const session = { id: 'cs_test_4', payment_status: 'paid' };
    mockConstructEvent.mockReturnValue({ type: 'checkout.session.completed', data: { object: session } });
    const err = new Error('price moved'); err.code = 'PRICE_DRIFT'; err.priceDrift = 12.5;
    mockBookFromSession.mockRejectedValue(err);
    const app = buildApp();
    await request(app).post('/webhooks/stripe')
      .set('stripe-signature', 'valid-sig')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ any: 'thing' }));
    await flush();
    expect(log).toHaveBeenCalledWith('warn', 'webhook_booking_blocked_price_drift', expect.objectContaining({ drift: 12.5 }));
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(mockRecordBookingFailureEvent).not.toHaveBeenCalled();
  });

  test('a genuine booking failure after payment is logged, recorded, and sent to Sentry', async () => {
    const session = { id: 'cs_test_5', payment_status: 'paid' };
    mockConstructEvent.mockReturnValue({ type: 'checkout.session.completed', data: { object: session } });
    const err = new Error('duffel rejected the order'); err.details = { code: 'invalid' }; err.refunded = true;
    mockBookFromSession.mockRejectedValue(err);
    const app = buildApp();
    await request(app).post('/webhooks/stripe')
      .set('stripe-signature', 'valid-sig')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ any: 'thing' }));
    await flush();
    expect(log).toHaveBeenCalledWith('error', 'webhook_booking_failed', expect.objectContaining({ message: 'duffel rejected the order', refunded: true }));
    expect(mockRecordBookingFailureEvent).toHaveBeenCalledWith(expect.objectContaining({ source: 'webhook', refunded: true }));
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});

describe('POST /webhooks/duffel', () => {
  test('rejects a request with no signature header', async () => {
    const app = buildApp();
    const res = await request(app).post('/webhooks/duffel')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ type: 'order_cancellation.confirmed' }));
    expect(res.status).toBe(400);
  });

  test('rejects a tampered/invalid signature', async () => {
    const body = JSON.stringify({ type: 'order_cancellation.confirmed', data: { object: { order_id: 'ord_1' } } });
    const badSig = signDuffelBody(body, 'wrong-secret');
    const app = buildApp();
    const res = await request(app).post('/webhooks/duffel')
      .set('x-duffel-signature', badSig)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(400);
    expect(supa.from).not.toHaveBeenCalled();
  });

  test('a validly-signed order_cancellation.confirmed event marks the booking cancelled', async () => {
    supa.__setResponse('bookings', { result: { data: null, error: null } });
    const body = JSON.stringify({ type: 'order_cancellation.confirmed', data: { object: { order_id: 'ord_42', refund_amount: '50.00' } } });
    const sig = signDuffelBody(body, 'duffel_test_secret');
    const app = buildApp();
    const res = await request(app).post('/webhooks/duffel')
      .set('x-duffel-signature', sig)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    await flush();
    expect(supa.from).toHaveBeenCalledWith('bookings');
  });

  test('logs an error (without crashing) when the DB update fails', async () => {
    supa.__setResponse('bookings', { result: { data: null, error: { message: 'connection lost' } } });
    const body = JSON.stringify({ type: 'order_cancellation.confirmed', data: { object: { order_id: 'ord_99' } } });
    const sig = signDuffelBody(body, 'duffel_test_secret');
    const app = buildApp();
    const res = await request(app).post('/webhooks/duffel')
      .set('x-duffel-signature', sig)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(200);
    await flush();
    expect(log).toHaveBeenCalledWith('error', 'duffel_webhook_cancel_sync_failed', expect.objectContaining({ order_id: 'ord_99' }));
  });

  test('ignores an unrecognized event type without error', async () => {
    const body = JSON.stringify({ type: 'some.other.event', data: { object: {} } });
    const sig = signDuffelBody(body, 'duffel_test_secret');
    const app = buildApp();
    const res = await request(app).post('/webhooks/duffel')
      .set('x-duffel-signature', sig)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(200);
  });
});
