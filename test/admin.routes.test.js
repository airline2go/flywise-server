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
      in: () => builder,
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

describe('POST/PUT /admin/route-pages — refresh_frequency validation', () => {
  test('POST rejects an invalid refresh_frequency', async () => {
    const app = buildApp();
    const res = await request(app).post('/admin/route-pages').set(AUTH).send({
      origin_iata: 'BER', destination_iata: 'CDG', origin_city: 'Berlin', destination_city: 'Paris',
      refresh_frequency: 'hourly',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/refresh_frequency/);
  });

  test('POST accepts a valid refresh_frequency and stores it on the row', async () => {
    supa.__setResponse('route_pages', { maybeSingle: { data: null, error: null }, result: { data: null, error: null } });
    let insertedRow = null;
    const originalFrom = supa.from.getMockImplementation();
    supa.from.mockImplementation((table) => {
      if (table === 'route_pages') {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }), maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
          insert: (row) => { insertedRow = row; return { select: () => ({ maybeSingle: () => Promise.resolve({ data: { ...row, id: 'r1' }, error: null }) }) }; },
        };
      }
      return originalFrom(table);
    });
    const app = buildApp();
    const res = await request(app).post('/admin/route-pages').set(AUTH).send({
      origin_iata: 'BER', destination_iata: 'CDG', origin_city: 'Berlin', destination_city: 'Paris',
      refresh_frequency: '6h',
    });
    expect(res.status).toBe(200);
    expect(insertedRow.refresh_frequency).toBe('6h');
  });

  test('POST defaults to none when refresh_frequency is omitted', async () => {
    let insertedRow = null;
    const originalFrom = supa.from.getMockImplementation();
    supa.from.mockImplementation((table) => {
      if (table === 'route_pages') {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }), maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
          insert: (row) => { insertedRow = row; return { select: () => ({ maybeSingle: () => Promise.resolve({ data: { ...row, id: 'r2' }, error: null }) }) }; },
        };
      }
      return originalFrom(table);
    });
    const app = buildApp();
    const res = await request(app).post('/admin/route-pages').set(AUTH).send({
      origin_iata: 'HAM', destination_iata: 'MAD', origin_city: 'Hamburg', destination_city: 'Madrid',
    });
    expect(res.status).toBe(200);
    expect(insertedRow.refresh_frequency).toBe('none');
  });

  test('PUT rejects an invalid refresh_frequency', async () => {
    const app = buildApp();
    const res = await request(app).put('/admin/route-pages/r1').set(AUTH).send({ refresh_frequency: 'weekly' });
    expect(res.status).toBe(400);
  });

  test('PUT passes a valid refresh_frequency through to the update', async () => {
    let updatedWith = null;
    const originalFrom = supa.from.getMockImplementation();
    supa.from.mockImplementation((table) => {
      if (table === 'route_pages') {
        return { update: (payload) => { updatedWith = payload; return { eq: () => ({ select: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'r1', refresh_frequency: payload.refresh_frequency }, error: null }) }) }) }; } };
      }
      return originalFrom(table);
    });
    const app = buildApp();
    const res = await request(app).put('/admin/route-pages/r1').set(AUTH).send({ refresh_frequency: '24h' });
    expect(res.status).toBe(200);
    expect(updatedWith.refresh_frequency).toBe('24h');
  });
});

describe('GET /admin/route-pages — refresh_frequency filter', () => {
  test('applies a valid refresh_frequency filter', async () => {
    let filteredWith = null;
    const originalFrom = supa.from.getMockImplementation();
    supa.from.mockImplementation((table) => {
      if (table === 'route_pages') {
        const builder = {
          select: () => builder,
          eq: (col, val) => { if (col === 'refresh_frequency') filteredWith = val; return builder; },
          order: () => builder,
          range: () => Promise.resolve({ data: [], error: null, count: 0 }),
        };
        return builder;
      }
      return originalFrom(table);
    });
    const app = buildApp();
    const res = await request(app).get('/admin/route-pages?refresh_frequency=6h').set(AUTH);
    expect(res.status).toBe(200);
    expect(filteredWith).toBe('6h');
  });

  test('ignores an invalid refresh_frequency value silently (no filter applied)', async () => {
    let filterCalled = false;
    const originalFrom = supa.from.getMockImplementation();
    supa.from.mockImplementation((table) => {
      if (table === 'route_pages') {
        const builder = {
          select: () => builder,
          eq: (col) => { if (col === 'refresh_frequency') filterCalled = true; return builder; },
          order: () => builder,
          range: () => Promise.resolve({ data: [], error: null, count: 0 }),
        };
        return builder;
      }
      return originalFrom(table);
    });
    const app = buildApp();
    const res = await request(app).get('/admin/route-pages?refresh_frequency=bogus').set(AUTH);
    expect(res.status).toBe(200);
    expect(filterCalled).toBe(false);
  });
});

describe('POST /admin/route-pages/bulk-create — refresh_frequency', () => {
  test('rejects an invalid refresh_frequency', async () => {
    const app = buildApp();
    const res = await request(app).post('/admin/route-pages/bulk-create').set(AUTH).send({
      airports: [{ code: 'BER', city: 'Berlin' }, { code: 'CDG', city: 'Paris' }],
      refresh_frequency: 'sometimes',
    });
    expect(res.status).toBe(400);
  });

  test('defaults every inserted route to none when omitted', async () => {
    let upsertedRows = null;
    const originalFrom = supa.from.getMockImplementation();
    supa.from.mockImplementation((table) => {
      if (table === 'route_pages') {
        return {
          select: () => Promise.resolve({ data: [], error: null }),
          upsert: (rows) => { upsertedRows = rows; return { select: () => Promise.resolve({ data: rows.map((r, i) => ({ id: 'g' + i })), error: null }) }; },
        };
      }
      return originalFrom(table);
    });
    const app = buildApp();
    const res = await request(app).post('/admin/route-pages/bulk-create').set(AUTH).send({
      airports: [{ code: 'BER', city: 'Berlin' }, { code: 'CDG', city: 'Paris' }],
    });
    expect(res.status).toBe(200);
    expect(upsertedRows.every((r) => r.refresh_frequency === 'none')).toBe(true);
  });

  test('applies a given refresh_frequency to the whole batch', async () => {
    let upsertedRows = null;
    const originalFrom = supa.from.getMockImplementation();
    supa.from.mockImplementation((table) => {
      if (table === 'route_pages') {
        return {
          select: () => Promise.resolve({ data: [], error: null }),
          upsert: (rows) => { upsertedRows = rows; return { select: () => Promise.resolve({ data: rows.map((r, i) => ({ id: 'g' + i })), error: null }) }; },
        };
      }
      return originalFrom(table);
    });
    const app = buildApp();
    const res = await request(app).post('/admin/route-pages/bulk-create').set(AUTH).send({
      airports: [{ code: 'BER', city: 'Berlin' }, { code: 'CDG', city: 'Paris' }],
      refresh_frequency: '12h',
    });
    expect(res.status).toBe(200);
    expect(upsertedRows.every((r) => r.refresh_frequency === '12h')).toBe(true);
  });
});

describe('PUT /admin/route-pages/bulk-refresh', () => {
  test('rejects a missing ids array', async () => {
    const app = buildApp();
    const res = await request(app).put('/admin/route-pages/bulk-refresh').set(AUTH).send({ refresh_frequency: '6h' });
    expect(res.status).toBe(400);
  });

  test('rejects more than 500 ids', async () => {
    const app = buildApp();
    const ids = Array.from({ length: 501 }, (_, i) => 'id-' + i);
    const res = await request(app).put('/admin/route-pages/bulk-refresh').set(AUTH).send({ ids, refresh_frequency: '6h' });
    expect(res.status).toBe(400);
  });

  test('rejects an invalid refresh_frequency', async () => {
    const app = buildApp();
    const res = await request(app).put('/admin/route-pages/bulk-refresh').set(AUTH).send({ ids: ['id-1'], refresh_frequency: 'never' });
    expect(res.status).toBe(400);
  });

  test('updates the given ids to the requested refresh_frequency', async () => {
    let updatedWith = null;
    let updatedIds = null;
    const originalFrom = supa.from.getMockImplementation();
    supa.from.mockImplementation((table) => {
      if (table === 'route_pages') {
        return {
          update: (payload) => {
            updatedWith = payload;
            return { in: (col, ids) => { updatedIds = ids; return { select: () => Promise.resolve({ data: ids.map((id) => ({ id })), error: null }) }; } };
          },
        };
      }
      return originalFrom(table);
    });
    const app = buildApp();
    const res = await request(app).put('/admin/route-pages/bulk-refresh').set(AUTH).send({ ids: ['id-1', 'id-2'], refresh_frequency: '24h' });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
    expect(updatedWith.refresh_frequency).toBe('24h');
    expect(updatedIds).toEqual(['id-1', 'id-2']);
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
