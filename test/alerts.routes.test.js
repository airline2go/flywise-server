jest.mock('../src/clients/supabase', () => {
  const responses = {};
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

beforeEach(() => {
  supa.__reset();
  supa.from.mockClear();
  mockDuffelFn.mockReset();
});

describe('POST /alerts', () => {
  test('requires user_id, origin, and destination', async () => {
    const res = await request(app).post('/alerts').send({ origin: 'BER' });
    expect(res.status).toBe(400);
  });

  test('creates a saved trip alert', async () => {
    supa.__setResponse('saved_trips', { maybeSingle: { data: { id: 1, origin: 'BER', destination: 'CDG' }, error: null } });
    const res = await request(app).post('/alerts').send({ user_id: 'u1', origin: 'BER', destination: 'CDG', target_price: '150' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, alert: { id: 1, origin: 'BER', destination: 'CDG' } });
  });

  test('surfaces a database error as a 500', async () => {
    supa.__setResponse('saved_trips', { maybeSingle: { data: null, error: { message: 'insert failed' } } });
    const res = await request(app).post('/alerts').send({ user_id: 'u1', origin: 'BER', destination: 'CDG' });
    expect(res.status).toBe(500);
  });
});

describe('GET /alerts/:userId', () => {
  test("returns the user's active alerts", async () => {
    supa.__setResponse('saved_trips', { result: { data: [{ id: 1, origin: 'BER', destination: 'CDG' }], error: null } });
    const res = await request(app).get('/alerts/u1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, alerts: [{ id: 1, origin: 'BER', destination: 'CDG' }] });
  });

  test('returns an empty list rather than an error when there are none', async () => {
    supa.__setResponse('saved_trips', { result: { data: null, error: null } });
    const res = await request(app).get('/alerts/u1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, alerts: [] });
  });

  test('surfaces a database error as a 500', async () => {
    supa.__setResponse('saved_trips', { result: { data: null, error: { message: 'connection lost' } } });
    const res = await request(app).get('/alerts/u1');
    expect(res.status).toBe(500);
  });
});

describe('POST /alerts/:id/delete', () => {
  test('requires user_id', async () => {
    const res = await request(app).post('/alerts/1/delete').send({});
    expect(res.status).toBe(400);
  });

  test('deletes the alert', async () => {
    supa.__setResponse('saved_trips', { result: { data: null, error: null } });
    const res = await request(app).post('/alerts/1/delete').send({ user_id: 'u1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: true });
  });

  test('surfaces a database error as a 500', async () => {
    supa.__setResponse('saved_trips', { result: { data: null, error: { message: 'delete failed' } } });
    const res = await request(app).post('/alerts/1/delete').send({ user_id: 'u1' });
    expect(res.status).toBe(500);
  });
});

describe('POST /alerts/:id/check', () => {
  test('404s when the saved trip does not exist', async () => {
    supa.__setResponse('saved_trips', { maybeSingle: { data: null, error: null } });
    const res = await request(app).post('/alerts/999/check').send({});
    expect(res.status).toBe(404);
  });

  test('returns the cheapest live price and whether the target was reached', async () => {
    supa.__setResponse('saved_trips', {
      maybeSingle: { data: { id: 1, origin: 'BER', destination: 'CDG', departure_date: '2026-08-01', target_price: 100 }, error: null },
    });
    mockDuffelFn.mockResolvedValue({ data: { offers: [{ total_amount: '90.00' }, { total_amount: '120.00' }] } });
    const res = await request(app).post('/alerts/1/check').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, cheapest_price: 90, currency: 'EUR', target_price: 100, target_reached: true });
  });

  test('target_reached is false when the cheapest price is still above target', async () => {
    supa.__setResponse('saved_trips', {
      maybeSingle: { data: { id: 2, origin: 'BER', destination: 'CDG', departure_date: '2026-08-01', target_price: 50 }, error: null },
    });
    mockDuffelFn.mockResolvedValue({ data: { offers: [{ total_amount: '90.00' }] } });
    const res = await request(app).post('/alerts/2/check').send({});
    expect(res.body.target_reached).toBe(false);
  });

  test('propagates a Duffel error with its status', async () => {
    supa.__setResponse('saved_trips', {
      maybeSingle: { data: { id: 3, origin: 'BER', destination: 'CDG', departure_date: '2026-08-01', target_price: null }, error: null },
    });
    const err = new Error('supplier down'); err.status = 503;
    mockDuffelFn.mockRejectedValue(err);
    const res = await request(app).post('/alerts/3/check').send({});
    expect(res.status).toBe(503);
  });
});
