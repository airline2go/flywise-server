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
      limit: () => builder,
      update: () => builder,
      insert: () => builder,
      maybeSingle: () => Promise.resolve(cfg.maybeSingle || { data: null, error: null }),
      then: (resolve, reject) => Promise.resolve(cfg.result || { data: null, error: null }).then(resolve, reject),
    };
    return builder;
  }
  return {
    from: jest.fn((table) => makeBuilder(table)),
    __push: (table, cfg) => { (queues[table] = queues[table] || []).push(cfg); },
    __reset: () => { for (const k of Object.keys(queues)) delete queues[k]; },
  };
});

jest.mock('../src/utils/log', () => jest.fn());

const express = require('express');
const request = require('supertest');
const supa = require('../src/clients/supabase');

function buildApp() {
  const app = express();
  app.use(express.json());
  require('../src/routes/admin-customers.routes')(app);
  return app;
}

const OWNER_AUTH = { Authorization: 'Bearer test-admin-token' };

beforeEach(() => {
  supa.__reset();
  supa.from.mockClear();
});

function staffAuthHeaders() {
  supa.__push('admin_sessions', {
    maybeSingle: { data: { admin_user_id: 'staff-1', role: 'staff', expires_at: new Date(Date.now() + 3600000).toISOString() }, error: null },
  });
  supa.__push('admin_users', { maybeSingle: { data: { active: true }, error: null } });
  return { Authorization: 'Bearer some-staff-session-token' };
}

describe('POST /admin/customers/credit — auth boundary', () => {
  test('a staff session is blocked (403), never a full admin action', async () => {
    const app = buildApp();
    const res = await request(app).post('/admin/customers/credit').set(staffAuthHeaders()).set('X-Forwarded-For', '10.2.1.1').send({ user_id: 'u1', amount: 10 });
    expect(res.status).toBe(403);
  });

  test('no token at all is rejected', async () => {
    const app = buildApp();
    const res = await request(app).post('/admin/customers/credit').set('X-Forwarded-For', '10.2.1.2').send({ user_id: 'u1', amount: 10 });
    expect([401, 503]).toContain(res.status);
  });
});

describe('POST /admin/customers/credit — validation', () => {
  test('rejects a missing user_id', async () => {
    const app = buildApp();
    const res = await request(app).post('/admin/customers/credit').set(OWNER_AUTH).set('X-Forwarded-For', '10.2.2.1').send({ amount: 10 });
    expect(res.status).toBe(400);
  });

  test('rejects a zero amount', async () => {
    const app = buildApp();
    const res = await request(app).post('/admin/customers/credit').set(OWNER_AUTH).set('X-Forwarded-For', '10.2.2.2').send({ user_id: 'u1', amount: 0 });
    expect(res.status).toBe(400);
  });

  test('rejects a negative amount', async () => {
    const app = buildApp();
    const res = await request(app).post('/admin/customers/credit').set(OWNER_AUTH).set('X-Forwarded-For', '10.2.2.3').send({ user_id: 'u1', amount: -5 });
    expect(res.status).toBe(400);
  });

  test('rejects an amount above the configured cap', async () => {
    const app = buildApp();
    const res = await request(app).post('/admin/customers/credit').set(OWNER_AUTH).set('X-Forwarded-For', '10.2.2.4').send({ user_id: 'u1', amount: 1500 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/1000/);
  });

  test('rejects a user_id with no matching booking (unknown customer)', async () => {
    supa.__push('bookings', { maybeSingle: { data: null, error: null } });
    const app = buildApp();
    const res = await request(app).post('/admin/customers/credit').set(OWNER_AUTH).set('X-Forwarded-For', '10.2.2.5').send({ user_id: 'nobody', amount: 10 });
    expect(res.status).toBe(404);
  });
});

describe('POST /admin/customers/credit — success path', () => {
  test('computes old/new balance correctly and writes both ledger rows', async () => {
    supa.__push('bookings', { maybeSingle: { data: { id: 'b1' }, error: null } });
    supa.__push('loyalty_accounts', { maybeSingle: { data: { user_id: 'u1', credit: 25.5 }, error: null }, result: { error: null } });

    let ledgerInsert = null;
    let creditLogInsert = null;
    const originalFrom = supa.from.getMockImplementation();
    supa.from.mockImplementation((table) => {
      if (table === 'loyalty_transactions') {
        return { insert: (row) => { ledgerInsert = row; return Promise.resolve({ error: null }); } };
      }
      if (table === 'admin_credit_log') {
        return { insert: (row) => { creditLogInsert = row; return Promise.resolve({ error: null }); } };
      }
      return originalFrom(table);
    });

    const app = buildApp();
    const res = await request(app).post('/admin/customers/credit').set(OWNER_AUTH).set('X-Forwarded-For', '10.2.3.1').send({ user_id: 'u1', amount: 15.25, reason: 'goodwill gesture' });

    expect(res.status).toBe(200);
    expect(res.body.old_balance).toBe(25.5);
    expect(res.body.new_balance).toBe(40.75);

    expect(ledgerInsert).toMatchObject({
      user_id: 'u1', type: 'admin_credit', amount: 15.25, balance_after: 40.75, note: 'goodwill gesture',
    });
    expect(creditLogInsert).toMatchObject({
      target_user_id: 'u1', amount: 15.25, old_balance: 25.5, new_balance: 40.75, reason: 'goodwill gesture',
    });
  });

  test('reason is optional — omitting it still succeeds with a null note', async () => {
    supa.__push('bookings', { maybeSingle: { data: { id: 'b1' }, error: null } });
    supa.__push('loyalty_accounts', { maybeSingle: { data: { user_id: 'u1', credit: 0 }, error: null }, result: { error: null } });

    let ledgerInsert = null;
    const originalFrom = supa.from.getMockImplementation();
    supa.from.mockImplementation((table) => {
      if (table === 'loyalty_transactions') {
        return { insert: (row) => { ledgerInsert = row; return Promise.resolve({ error: null }); } };
      }
      return originalFrom(table);
    });

    const app = buildApp();
    const res = await request(app).post('/admin/customers/credit').set(OWNER_AUTH).set('X-Forwarded-For', '10.2.3.2').send({ user_id: 'u1', amount: 5 });

    expect(res.status).toBe(200);
    expect(ledgerInsert.note).toBeNull();
  });
});
