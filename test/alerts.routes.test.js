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

const mockDuffelFn = jest.fn();
jest.mock('../src/services/duffel', () => {
  const fn = (...args) => mockDuffelFn(...args);
  return fn;
});

jest.mock('../src/utils/log', () => jest.fn());

const express = require('express');
const request = require('supertest');
const supa = require('../src/clients/supabase');

function buildApp() {
  const app = express();
  app.use(express.json());
  require('../src/routes/alerts.routes')(app);
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
  mockDuffelFn.mockReset();
});

describe('POST /alerts', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await request(app).post('/alerts').send({ origin: 'BER', destination: 'CDG' });
    expect(res.status).toBe(401);
  });

  test('requires origin and destination', async () => {
    const headers = authAs('u1');
    const res = await request(app).post('/alerts').set(headers).send({ origin: 'BER' });
    expect(res.status).toBe(400);
  });

  test('creates a saved trip alert scoped to the caller, ignoring any client-supplied user_id', async () => {
    const headers = authAs('u1');
    supa.__setResponse('saved_trips', { maybeSingle: { data: { id: 1, origin: 'BER', destination: 'CDG' }, error: null } });
    const res = await request(app).post('/alerts').set(headers).send({ user_id: 'attacker-id', origin: 'BER', destination: 'CDG', target_price: '150' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, alert: { id: 1, origin: 'BER', destination: 'CDG' } });
  });

  test('surfaces a database error as a 500', async () => {
    const headers = authAs('u1');
    supa.__setResponse('saved_trips', { maybeSingle: { data: null, error: { message: 'insert failed' } } });
    const res = await request(app).post('/alerts').set(headers).send({ origin: 'BER', destination: 'CDG' });
    expect(res.status).toBe(500);
  });
});

describe('GET /alerts', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/alerts');
    expect(res.status).toBe(401);
  });

  test("returns only the caller's own active alerts", async () => {
    const headers = authAs('u1');
    supa.__setResponse('saved_trips', { result: { data: [{ id: 1, origin: 'BER', destination: 'CDG' }], error: null } });
    const res = await request(app).get('/alerts').set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, alerts: [{ id: 1, origin: 'BER', destination: 'CDG' }] });
  });

  test('returns an empty list rather than an error when there are none', async () => {
    const headers = authAs('u1');
    supa.__setResponse('saved_trips', { result: { data: null, error: null } });
    const res = await request(app).get('/alerts').set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, alerts: [] });
  });

  test('surfaces a database error as a 500', async () => {
    const headers = authAs('u1');
    supa.__setResponse('saved_trips', { result: { data: null, error: { message: 'connection lost' } } });
    const res = await request(app).get('/alerts').set(headers);
    expect(res.status).toBe(500);
  });
});

describe('POST /alerts/:id/delete', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await request(app).post('/alerts/1/delete').send({});
    expect(res.status).toBe(401);
  });

  test('deletes the alert, scoping the delete to the caller (never a client-supplied user_id)', async () => {
    const headers = authAs('u1');
    supa.__setResponse('saved_trips', { result: { data: null, error: null } });
    const res = await request(app).post('/alerts/1/delete').set(headers).send({ user_id: 'attacker-id' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: true });
  });

  test('surfaces a database error as a 500', async () => {
    const headers = authAs('u1');
    supa.__setResponse('saved_trips', { result: { data: null, error: { message: 'delete failed' } } });
    const res = await request(app).post('/alerts/1/delete').set(headers).send({});
    expect(res.status).toBe(500);
  });
});

describe('POST /alerts/:id/check', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await request(app).post('/alerts/1/check').send({});
    expect(res.status).toBe(401);
  });

  test('404s when the saved trip does not exist (or does not belong to the caller)', async () => {
    const headers = authAs('u1');
    supa.__setResponse('saved_trips', { maybeSingle: { data: null, error: null } });
    const res = await request(app).post('/alerts/999/check').set(headers).send({});
    expect(res.status).toBe(404);
  });

  test('returns the cheapest live price and whether the target was reached', async () => {
    const headers = authAs('u1');
    supa.__setResponse('saved_trips', {
      maybeSingle: { data: { id: 1, origin: 'BER', destination: 'CDG', departure_date: '2026-08-01', target_price: 100 }, error: null },
    });
    mockDuffelFn.mockResolvedValue({ data: { offers: [{ total_amount: '90.00' }, { total_amount: '120.00' }] } });
    const res = await request(app).post('/alerts/1/check').set(headers).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, cheapest_price: 90, currency: 'EUR', target_price: 100, target_reached: true });
  });

  test('target_reached is false when the cheapest price is still above target', async () => {
    const headers = authAs('u1');
    supa.__setResponse('saved_trips', {
      maybeSingle: { data: { id: 2, origin: 'BER', destination: 'CDG', departure_date: '2026-08-01', target_price: 50 }, error: null },
    });
    mockDuffelFn.mockResolvedValue({ data: { offers: [{ total_amount: '90.00' }] } });
    const res = await request(app).post('/alerts/2/check').set(headers).send({});
    expect(res.body.target_reached).toBe(false);
  });

  test('propagates a Duffel error with its status', async () => {
    const headers = authAs('u1');
    supa.__setResponse('saved_trips', {
      maybeSingle: { data: { id: 3, origin: 'BER', destination: 'CDG', departure_date: '2026-08-01', target_price: null }, error: null },
    });
    const err = new Error('supplier down'); err.status = 503;
    mockDuffelFn.mockRejectedValue(err);
    const res = await request(app).post('/alerts/3/check').set(headers).send({});
    expect(res.status).toBe(503);
  });
});
