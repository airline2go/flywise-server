process.env.ADMIN_TOKEN = 'test-admin-token';

jest.mock('../src/clients/supabase', () => {
  const responses = {}; // table -> { maybeSingle, result, rpcResult }
  function makeBuilder(table) {
    const cfg = responses[table] || {};
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      limit: () => builder,
      not: () => builder,
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
    rpc: jest.fn((name, params) => {
      const cfg = responses['__rpc_' + name] || {};
      return Promise.resolve(cfg.result || { data: null, error: null });
    }),
    __setResponse: (table, cfg) => { responses[table] = cfg; },
    __reset: () => { for (const k of Object.keys(responses)) delete responses[k]; },
  };
});

jest.mock('../src/utils/log', () => jest.fn());

const express = require('express');
const request = require('supertest');
const supa = require('../src/clients/supabase');

function buildApp() {
  const app = express();
  app.use(express.json());
  require('../src/routes/admin.routes')(app);
  return app;
}

const AUTH = { Authorization: 'Bearer test-admin-token' };

beforeEach(() => {
  supa.__reset();
  supa.from.mockClear();
  supa.rpc.mockClear();
});

describe('requireAdmin', () => {
  test('rejects a request with no bearer token', async () => {
    const app = buildApp();
    const res = await request(app).get('/admin/profit-tiers');
    expect(res.status).toBe(401);
  });

  test('rejects a request with the wrong token', async () => {
    const app = buildApp();
    const res = await request(app).get('/admin/profit-tiers').set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
  });

  test('accepts a request with the correct token', async () => {
    const app = buildApp();
    const res = await request(app).get('/admin/profit-tiers').set(AUTH);
    expect(res.status).toBe(200);
  });
});

describe('GET/POST /admin/profit-tiers', () => {
  test('GET falls back to the default tiers with no Supabase configured', async () => {
    const app = buildApp();
    const res = await request(app).get('/admin/profit-tiers').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.tiers).toEqual([
      { from: 0, to: 200, pct: 8, fixed: 5 },
      { from: 200, to: 500, pct: 6, fixed: 8 },
      { from: 500, to: null, pct: 4, fixed: 10 },
    ]);
  });

  test('POST rejects a percentage over 100', async () => {
    const app = buildApp();
    const res = await request(app).post('/admin/profit-tiers').set(AUTH).send({
      tiers: [{ from: 0, to: 100, pct: 150, fixed: 5 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Prozentsatz/);
  });

  test('POST rejects a tier whose "to" is not greater than "from"', async () => {
    const app = buildApp();
    const res = await request(app).post('/admin/profit-tiers').set(AUTH).send({
      tiers: [{ from: 100, to: 50, pct: 8, fixed: 5 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/"bis"/);
  });

  test('POST rejects an empty tiers array', async () => {
    const app = buildApp();
    const res = await request(app).post('/admin/profit-tiers').set(AUTH).send({ tiers: [] });
    expect(res.status).toBe(400);
  });

  test('POST accepts and echoes back a valid tier list', async () => {
    const app = buildApp();
    const tiers = [{ from: 0, to: 300, pct: 10, fixed: 3 }, { from: 300, to: null, pct: 5, fixed: 15 }];
    const res = await request(app).post('/admin/profit-tiers').set(AUTH).send({ tiers });
    expect(res.status).toBe(200);
    expect(res.body.tiers).toEqual(tiers);
  });
});

describe('POST /admin/promos — validation', () => {
  test('rejects a missing code', async () => {
    const app = buildApp();
    const res = await request(app).post('/admin/promos').set(AUTH).send({ type: 'fixed', value: 10 });
    expect(res.status).toBe(400);
  });

  test('rejects an invalid type', async () => {
    const app = buildApp();
    const res = await request(app).post('/admin/promos').set(AUTH).send({ code: 'SAVE10', type: 'bogus', value: 10 });
    expect(res.status).toBe(400);
  });

  test('rejects a percent value over 100', async () => {
    const app = buildApp();
    const res = await request(app).post('/admin/promos').set(AUTH).send({ code: 'SAVE10', type: 'percent', value: 150 });
    expect(res.status).toBe(400);
  });

  test('rejects a non-positive value', async () => {
    const app = buildApp();
    const res = await request(app).post('/admin/promos').set(AUTH).send({ code: 'SAVE10', type: 'fixed', value: 0 });
    expect(res.status).toBe(400);
  });

  test('a duplicate code (unique constraint) returns 409', async () => {
    supa.__setResponse('promo_codes', { maybeSingle: { data: null, error: { code: '23505', message: 'duplicate key' } } });
    const app = buildApp();
    const res = await request(app).post('/admin/promos').set(AUTH).send({ code: 'SAVE10', type: 'fixed', value: 10 });
    expect(res.status).toBe(409);
  });

  test('creates a valid promo code, normalized to uppercase', async () => {
    supa.__setResponse('promo_codes', { maybeSingle: { data: { id: 1, code: 'SAVE10', type: 'fixed', value: 10, active: true }, error: null } });
    const app = buildApp();
    const res = await request(app).post('/admin/promos').set(AUTH).send({ code: ' save10 ', type: 'fixed', value: 10 });
    expect(res.status).toBe(200);
    expect(res.body.promo.code).toBe('SAVE10');
  });
});

describe('POST /admin/promos/:id/toggle', () => {
  test('returns 404 when the code does not exist', async () => {
    supa.__setResponse('promo_codes', { maybeSingle: { data: null, error: null } });
    const app = buildApp();
    const res = await request(app).post('/admin/promos/999/toggle').set(AUTH);
    expect(res.status).toBe(404);
  });

  test('flips an active code to inactive', async () => {
    supa.__setResponse('promo_codes', { maybeSingle: { data: { active: true }, error: null }, result: { data: null, error: null } });
    const app = buildApp();
    const res = await request(app).post('/admin/promos/1/toggle').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
  });
});

describe('POST /admin/invoice-config — sanitization', () => {
  test('truncates an overlong prefix to 20 characters', async () => {
    const app = buildApp();
    const res = await request(app).post('/admin/invoice-config').set(AUTH).send({ prefix: 'A'.repeat(50) });
    expect(res.status).toBe(200);
    expect(res.body.config.prefix.length).toBe(20);
  });

  test('falls back to the default taxMode when given an invalid value', async () => {
    const app = buildApp();
    const res = await request(app).post('/admin/invoice-config').set(AUTH).send({ taxMode: 'not_a_real_mode' });
    expect(res.status).toBe(200);
    expect(res.body.config.taxMode).toBe('kleinunternehmer');
  });

  test('never lets nextNumber drop below 1', async () => {
    const app = buildApp();
    const res = await request(app).post('/admin/invoice-config').set(AUTH).send({ nextNumber: -5 });
    expect(res.status).toBe(200);
    expect(res.body.config.nextNumber).toBe(1);
  });
});

describe('POST /admin/invoices/issue', () => {
  test('rejects a missing customer_name', async () => {
    const app = buildApp();
    const res = await request(app).post('/admin/invoices/issue').set(AUTH).send({ amount: 100 });
    expect(res.status).toBe(400);
  });

  test('issues an invoice via the issue_invoice RPC using the configured prefix', async () => {
    supa.__setResponse('__rpc_issue_invoice', { result: { data: { invoice_number: 'AIRPIV-0001' }, error: null } });
    const app = buildApp();
    const res = await request(app).post('/admin/invoices/issue').set(AUTH).send({
      customer_name: 'Max Mustermann', amount: 199.99, currency: 'EUR',
    });
    expect(res.status).toBe(200);
    expect(res.body.invoice.invoice_number).toBe('AIRPIV-0001');
    expect(supa.rpc).toHaveBeenCalledWith('issue_invoice', expect.objectContaining({
      p_prefix: 'AIRPIV',
      p_customer_name: 'Max Mustermann',
      p_amount: 199.99,
    }));
  });
});

describe('rate limiting on requireAdmin-protected routes', () => {
  test('blocks further requests from the same IP once the shared admin bucket is exhausted', async () => {
    const app = buildApp();
    const ip = '10.9.9.9';
    let lastStatus;
    for (let i = 0; i < 121; i++) {
      const res = await request(app).get('/admin/profit-tiers').set(AUTH).set('X-Forwarded-For', ip);
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });

  test('is scoped per-IP, not global', async () => {
    const app = buildApp();
    const res = await request(app).get('/admin/profit-tiers').set(AUTH).set('X-Forwarded-For', '10.9.9.10');
    expect(res.status).toBe(200);
  });

  test('throttles even a request with an invalid token, before requireAdmin runs', async () => {
    const app = buildApp();
    const ip = '10.9.9.11';
    let lastStatus;
    for (let i = 0; i < 121; i++) {
      const res = await request(app).get('/admin/profit-tiers').set('Authorization', 'Bearer wrong-token').set('X-Forwarded-For', ip);
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
