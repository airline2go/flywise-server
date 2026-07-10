process.env.ADMIN_TOKEN = 'test-admin-token';

// [QUEUE-MOCK] Unlike the simpler single-response-per-table mocks
// elsewhere, admin-staff.routes.js issues several DIFFERENT queries
// against the SAME table within one request (e.g. a target-role check,
// then a count check, then the actual update — all on `admin_users`).
// A queue per table lets each test line up exactly the sequence of
// responses that request needs, in call order; once the queue has only
// one item left it's reused as a fallback for any further calls.
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
      order: () => builder,
      limit: () => builder,
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

jest.mock('../src/utils/log', () => jest.fn());

const express = require('express');
const request = require('supertest');
const supa = require('../src/clients/supabase');
const { hashPassword } = require('../src/services/adminAuth');

function buildApp() {
  const app = express();
  app.use(express.json());
  require('../src/routes/admin-staff.routes')(app);
  return app;
}

const OWNER_AUTH = { Authorization: 'Bearer test-admin-token' };

beforeEach(() => {
  supa.__reset();
  supa.from.mockClear();
});

// Helper: wires up a fresh, unexpired staff session so requireAdmin
// resolves req.adminRole/adminUserId via the session path instead of the
// legacy ADMIN_TOKEN — used to exercise the requireFullAdmin 403 boundary.
function staffAuthHeaders() {
  supa.__push('admin_sessions', {
    maybeSingle: { data: { admin_user_id: 'staff-1', role: 'staff', expires_at: new Date(Date.now() + 3600000).toISOString() }, error: null },
  });
  supa.__push('admin_users', { maybeSingle: { data: { active: true }, error: null } });
  return { Authorization: 'Bearer some-staff-session-token' };
}

describe('POST /admin/staff-login', () => {
  test('rejects missing email or password', async () => {
    const app = buildApp();
    const res = await request(app).post('/admin/staff-login').set('X-Forwarded-For', '10.1.1.1').send({ email: 'x@x.com' });
    expect(res.status).toBe(400);
  });

  test('rejects an unknown or wrong password with 401', async () => {
    supa.__push('admin_users', { maybeSingle: { data: null, error: null } });
    const app = buildApp();
    const res = await request(app).post('/admin/staff-login').set('X-Forwarded-For', '10.1.1.2').send({ email: 'nobody@x.com', password: 'whatever1' });
    expect(res.status).toBe(401);
  });

  test('rejects the right email with a wrong password', async () => {
    supa.__push('admin_users', {
      maybeSingle: { data: { id: 'u1', email: 'staff@x.com', name: 'Staff', role: 'staff', active: true, password_hash: hashPassword('correct-password') }, error: null },
    });
    const app = buildApp();
    const res = await request(app).post('/admin/staff-login').set('X-Forwarded-For', '10.1.1.3').send({ email: 'staff@x.com', password: 'wrong-password' });
    expect(res.status).toBe(401);
  });

  test('accepts a correct email+password and returns a session token', async () => {
    supa.__push('admin_users', {
      maybeSingle: { data: { id: 'u1', email: 'staff@x.com', name: 'Staff One', role: 'staff', active: true, password_hash: hashPassword('correct-password') }, error: null },
    });
    const app = buildApp();
    const res = await request(app).post('/admin/staff-login').set('X-Forwarded-For', '10.1.1.4').send({ email: 'staff@x.com', password: 'correct-password' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.role).toBe('staff');
    expect(res.body.name).toBe('Staff One');
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(20);
  });

  test('a deactivated account cannot log in even with the correct password', async () => {
    supa.__push('admin_users', {
      maybeSingle: { data: { id: 'u1', email: 'staff@x.com', name: 'Staff', role: 'staff', active: false, password_hash: hashPassword('correct-password') }, error: null },
    });
    const app = buildApp();
    const res = await request(app).post('/admin/staff-login').set('X-Forwarded-For', '10.1.1.5').send({ email: 'staff@x.com', password: 'correct-password' });
    expect(res.status).toBe(401);
  });

  test('rate-limits after 5 attempts from the same IP within the window', async () => {
    supa.__push('admin_users', { maybeSingle: { data: null, error: null } });
    const app = buildApp();
    const ip = '10.1.1.6';
    let lastStatus;
    for (let i = 0; i < 6; i++) {
      const res = await request(app).post('/admin/staff-login').set('X-Forwarded-For', ip).send({ email: 'x@x.com', password: 'wrongpass' });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});

describe('session expiry', () => {
  test('a session past its expires_at is rejected (falls through to 401)', async () => {
    supa.__push('admin_sessions', {
      maybeSingle: { data: { admin_user_id: 'staff-1', role: 'staff', expires_at: new Date(Date.now() - 1000).toISOString() }, error: null },
    });
    const app = buildApp();
    const res = await request(app).get('/admin/staff').set('Authorization', 'Bearer some-expired-token').set('X-Forwarded-For', '10.1.2.1');
    expect(res.status).toBe(401);
  });
});

describe('requireFullAdmin boundary', () => {
  test('a staff session is blocked (403) from listing staff', async () => {
    const app = buildApp();
    const res = await request(app).get('/admin/staff').set(staffAuthHeaders()).set('X-Forwarded-For', '10.1.3.1');
    expect(res.status).toBe(403);
  });

  test('a staff session is blocked (403) from creating staff', async () => {
    const app = buildApp();
    const res = await request(app).post('/admin/staff').set(staffAuthHeaders()).set('X-Forwarded-For', '10.1.3.2').send({ email: 'new@x.com', name: 'New', password: 'password1', role: 'staff' });
    expect(res.status).toBe(403);
  });

  test('the legacy ADMIN_TOKEN owner (unchanged) can list staff', async () => {
    supa.__push('admin_users', { result: { data: [], error: null } });
    const app = buildApp();
    const res = await request(app).get('/admin/staff').set(OWNER_AUTH).set('X-Forwarded-For', '10.1.3.3');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('no token at all is rejected', async () => {
    const app = buildApp();
    const res = await request(app).get('/admin/staff').set('X-Forwarded-For', '10.1.3.4');
    expect([401, 503]).toContain(res.status);
  });
});

describe('POST /admin/staff — creation', () => {
  test('rejects a password under 8 characters', async () => {
    const app = buildApp();
    const res = await request(app).post('/admin/staff').set(OWNER_AUTH).set('X-Forwarded-For', '10.1.4.1').send({ email: 'a@x.com', name: 'A', password: 'short', role: 'staff' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/8 Zeichen/);
  });

  test('a duplicate email returns 409', async () => {
    supa.__push('admin_users', { maybeSingle: { data: null, error: { code: '23505', message: 'duplicate key' } } });
    const app = buildApp();
    const res = await request(app).post('/admin/staff').set(OWNER_AUTH).set('X-Forwarded-For', '10.1.4.2').send({ email: 'dup@x.com', name: 'Dup', password: 'password1', role: 'staff' });
    expect(res.status).toBe(409);
  });

  test('creates a staff account and defaults an unrecognized role to staff', async () => {
    supa.__push('admin_users', { maybeSingle: { data: { id: 'new-1', email: 'new@x.com', name: 'New Person', role: 'staff', active: true }, error: null } });
    const app = buildApp();
    const res = await request(app).post('/admin/staff').set(OWNER_AUTH).set('X-Forwarded-For', '10.1.4.3').send({ email: 'new@x.com', name: 'New Person', password: 'password1', role: 'owner-of-everything' });
    expect(res.status).toBe(200);
    expect(res.body.staff.role).toBe('staff');
  });
});

describe('PUT /admin/staff/:id — last-active-admin guard', () => {
  test('refuses to demote the last active admin to staff', async () => {
    supa.__push('admin_users', { maybeSingle: { data: { role: 'admin', active: true }, error: null } });
    supa.__push('admin_users', { result: { count: 1, error: null } });
    const app = buildApp();
    const res = await request(app).put('/admin/staff/only-admin').set(OWNER_AUTH).set('X-Forwarded-For', '10.1.5.1').send({ role: 'staff' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/letzte aktive Administrator/);
  });

  test('refuses to deactivate the last active admin', async () => {
    supa.__push('admin_users', { maybeSingle: { data: { role: 'admin', active: true }, error: null } });
    supa.__push('admin_users', { result: { count: 1, error: null } });
    const app = buildApp();
    const res = await request(app).put('/admin/staff/only-admin').set(OWNER_AUTH).set('X-Forwarded-For', '10.1.5.2').send({ active: false });
    expect(res.status).toBe(400);
  });

  test('allows demoting an admin when another active admin still exists', async () => {
    supa.__push('admin_users', { maybeSingle: { data: { role: 'admin', active: true }, error: null } });
    supa.__push('admin_users', { result: { count: 2, error: null } });
    supa.__push('admin_users', { maybeSingle: { data: { id: 'admin-2', email: 'x@x.com', name: 'X', role: 'staff', active: true }, error: null } });
    const app = buildApp();
    const res = await request(app).put('/admin/staff/admin-2').set(OWNER_AUTH).set('X-Forwarded-For', '10.1.5.3').send({ role: 'staff' });
    expect(res.status).toBe(200);
    expect(res.body.staff.role).toBe('staff');
  });

  test('a plain name edit never triggers the guard query at all', async () => {
    supa.__push('admin_users', { maybeSingle: { data: { id: 'u2', email: 'x@x.com', name: 'New Name', role: 'staff', active: true }, error: null } });
    const app = buildApp();
    const res = await request(app).put('/admin/staff/u2').set(OWNER_AUTH).set('X-Forwarded-For', '10.1.5.4').send({ name: 'New Name' });
    expect(res.status).toBe(200);
    expect(res.body.staff.name).toBe('New Name');
  });

  test('rejects a password reset under 8 characters', async () => {
    const app = buildApp();
    const res = await request(app).put('/admin/staff/u2').set(OWNER_AUTH).set('X-Forwarded-For', '10.1.5.5').send({ password: 'short' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /admin/staff/:id — last-active-admin guard', () => {
  test('refuses to delete the last active admin', async () => {
    supa.__push('admin_users', { maybeSingle: { data: { role: 'admin', active: true }, error: null } });
    supa.__push('admin_users', { result: { count: 1, error: null } });
    const app = buildApp();
    const res = await request(app).delete('/admin/staff/only-admin').set(OWNER_AUTH).set('X-Forwarded-For', '10.1.6.1');
    expect(res.status).toBe(400);
  });

  test('allows deleting a staff account', async () => {
    supa.__push('admin_users', { maybeSingle: { data: { role: 'staff', active: true }, error: null } });
    const app = buildApp();
    const res = await request(app).delete('/admin/staff/staff-1').set(OWNER_AUTH).set('X-Forwarded-For', '10.1.6.2');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
