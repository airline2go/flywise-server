process.env.ADMIN_TOKEN = 'test-admin-token';

jest.mock('../src/clients/supabase', () => {
  const queues = {};
  function nextCfg(table) {
    const q = queues[table];
    if (!q || !q.length) return {};
    return q.length > 1 ? q.shift() : q[0];
  }
  function makeBuilder(table) {
    const cfg = nextCfg(table);
    const builder = {
      select: () => builder,
      eq: () => builder,
      or: () => builder,
      order: () => builder,
      range: () => builder,
      update: () => builder,
      insert: () => builder,
      delete: () => builder,
      maybeSingle: () => Promise.resolve(cfg.maybeSingle || { data: null, error: null }),
      then: (resolve, reject) => Promise.resolve(cfg.result || { data: null, error: null, count: cfg.count }).then(resolve, reject),
    };
    return builder;
  }
  return {
    from: jest.fn((table) => makeBuilder(table)),
    __push: (table, cfg) => { (queues[table] = queues[table] || []).push(cfg); },
    __reset: () => { for (const k of Object.keys(queues)) delete queues[k]; },
  };
});

const express = require('express');
const request = require('supertest');
const supa = require('../src/clients/supabase');

function buildApp() {
  const app = express();
  app.use(express.json());
  require('../src/routes/admin-airlines.routes')(app);
  return app;
}

const OWNER_AUTH = { Authorization: 'Bearer test-admin-token' };

beforeEach(() => {
  supa.__reset();
  supa.from.mockClear();
});

describe('GET /admin/airlines', () => {
  test('rejects without an admin token', async () => {
    const app = buildApp();
    const res = await request(app).get('/admin/airlines');
    expect(res.status).toBe(401);
  });

  test('lists airlines with pagination info', async () => {
    supa.__push('airlines', { result: { data: [{ id: '1', iata_code: 'LH', name: 'Lufthansa' }], error: null, count: 1 } });
    const app = buildApp();
    const res = await request(app).get('/admin/airlines').set(OWNER_AUTH);
    expect(res.status).toBe(200);
    expect(res.body.airlines).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });
});

describe('POST /admin/airlines', () => {
  test('requires iata_code and name', async () => {
    const app = buildApp();
    const res = await request(app).post('/admin/airlines').set(OWNER_AUTH).send({ name: 'Lufthansa' });
    expect(res.status).toBe(400);
  });

  test('creates an airline, uppercasing iata_code/country_code/hub_iata', async () => {
    supa.__push('airlines', { maybeSingle: { data: { id: '1', iata_code: 'LH', name: 'Lufthansa', country_code: 'DE', hub_iata: 'FRA' }, error: null } });
    const app = buildApp();
    const res = await request(app).post('/admin/airlines').set(OWNER_AUTH).send({ iata_code: 'lh', name: 'Lufthansa', country_code: 'de', hub_iata: 'fra' });
    expect(res.status).toBe(200);
    expect(res.body.airline.iata_code).toBe('LH');
  });

  test('country_code and hub_iata are optional', async () => {
    supa.__push('airlines', { maybeSingle: { data: { id: '1', iata_code: 'LH', name: 'Lufthansa', country_code: null, hub_iata: null }, error: null } });
    const app = buildApp();
    const res = await request(app).post('/admin/airlines').set(OWNER_AUTH).send({ iata_code: 'LH', name: 'Lufthansa' });
    expect(res.status).toBe(200);
  });
});

describe('PUT /admin/airlines/:id', () => {
  test('404s when the airline does not exist', async () => {
    supa.__push('airlines', { maybeSingle: { data: null, error: null } });
    const app = buildApp();
    const res = await request(app).put('/admin/airlines/missing').set(OWNER_AUTH).send({ name: 'X' });
    expect(res.status).toBe(404);
  });

  test('[ROUTE-INTELLIGENCE-3] updates country_code and hub_iata, uppercased', async () => {
    supa.__push('airlines', { maybeSingle: { data: { id: '1', iata_code: 'LH', name: 'Lufthansa', country_code: 'DE', hub_iata: 'MUC' }, error: null } });
    const app = buildApp();
    const res = await request(app).put('/admin/airlines/1').set(OWNER_AUTH).send({ country_code: 'de', hub_iata: 'muc' });
    expect(res.status).toBe(200);
    expect(res.body.airline.country_code).toBe('DE');
    expect(res.body.airline.hub_iata).toBe('MUC');
  });

  test('an empty string clears hub_iata back to null (reverting to inference)', async () => {
    supa.__push('airlines', { maybeSingle: { data: { id: '1', iata_code: 'LH', name: 'Lufthansa', hub_iata: null }, error: null } });
    const app = buildApp();
    const res = await request(app).put('/admin/airlines/1').set(OWNER_AUTH).send({ hub_iata: '' });
    expect(res.status).toBe(200);
  });
});

describe('DELETE /admin/airlines/:id', () => {
  test('deletes an airline', async () => {
    supa.__push('airlines', { result: { data: null, error: null } });
    const app = buildApp();
    const res = await request(app).delete('/admin/airlines/1').set(OWNER_AUTH);
    expect(res.status).toBe(200);
  });
});
