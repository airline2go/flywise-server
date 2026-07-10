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
      in: () => builder,
      or: () => builder,
      order: () => builder,
      range: () => builder,
      update: () => builder,
      insert: () => builder,
      upsert: () => builder,
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

function buildApp() {
  const app = express();
  app.use(express.json());
  require('../src/routes/admin-geo.routes')(app);
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

describe('auth boundary — content CRUD is requireAdmin, not requireFullAdmin', () => {
  test('an unauthenticated request is rejected', async () => {
    const app = buildApp();
    const res = await request(app).get('/admin/cities');
    expect(res.status).toBe(401);
  });

  test('a staff session IS allowed (unlike margin/credit endpoints)', async () => {
    const app = buildApp();
    supa.__push('cities', { result: { data: [], error: null, count: 0 } });
    const res = await request(app).get('/admin/cities').set(staffAuthHeaders());
    expect(res.status).toBe(200);
  });
});

describe('GET /admin/cities', () => {
  test('returns a paginated list with translation counts attached', async () => {
    supa.__push('cities', { result: { data: [{ id: 'city-1', name: 'Berlin', city_slug: 'berlin' }], error: null, count: 1 } });
    supa.__push('city_translations', { result: { data: [{ city_id: 'city-1' }, { city_id: 'city-1' }], error: null } });
    const app = buildApp();
    const res = await request(app).get('/admin/cities').set(OWNER_AUTH);
    expect(res.status).toBe(200);
    expect(res.body.cities[0].translations_count).toBe(2);
    expect(res.body.total).toBe(1);
  });
});

describe('POST /admin/cities', () => {
  test('requires city_slug and name', async () => {
    const app = buildApp();
    const res = await request(app).post('/admin/cities').set(OWNER_AUTH).send({ name: 'Berlin' });
    expect(res.status).toBe(400);
  });

  test('creates a city', async () => {
    supa.__push('cities', { maybeSingle: { data: { id: 'city-1', city_slug: 'berlin', name: 'Berlin' }, error: null } });
    const app = buildApp();
    const res = await request(app).post('/admin/cities').set(OWNER_AUTH).send({ city_slug: 'Berlin', name: 'Berlin', country_code: 'DE' });
    expect(res.status).toBe(200);
    expect(res.body.city.city_slug).toBe('berlin');
  });
});

describe('PUT /admin/cities/:id/translations', () => {
  test('rejects an unknown language code', async () => {
    const app = buildApp();
    const res = await request(app).put('/admin/cities/city-1/translations').set(OWNER_AUTH).send({ translations: { xx: 'Nope' } });
    expect(res.status).toBe(400);
  });

  test('upserts only the provided, non-empty languages', async () => {
    supa.__push('city_translations', { result: { data: null, error: null } });
    const app = buildApp();
    const res = await request(app).put('/admin/cities/city-1/translations').set(OWNER_AUTH)
      .send({ translations: { en: 'Munich', de: '', ar: 'ميونخ' } });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2); // 'de' was empty -> skipped
  });
});

describe('DELETE /admin/cities/:id', () => {
  test('deletes a city', async () => {
    supa.__push('cities', { result: { data: null, error: null } });
    const app = buildApp();
    const res = await request(app).delete('/admin/cities/city-1').set(OWNER_AUTH);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('GET /admin/countries', () => {
  test('returns a paginated list with translation counts attached', async () => {
    supa.__push('countries', { result: { data: [{ id: 'country-1', code: 'DE', name: 'Deutschland' }], error: null, count: 1 } });
    supa.__push('country_translations', { result: { data: [{ country_code: 'DE' }], error: null } });
    const app = buildApp();
    const res = await request(app).get('/admin/countries').set(OWNER_AUTH);
    expect(res.status).toBe(200);
    expect(res.body.countries[0].translations_count).toBe(1);
  });
});

describe('PUT /admin/countries/:id/translations', () => {
  test('404s when the country id does not exist', async () => {
    supa.__push('countries', { maybeSingle: { data: null, error: null } });
    const app = buildApp();
    const res = await request(app).put('/admin/countries/nope/translations').set(OWNER_AUTH).send({ translations: { en: 'Germany' } });
    expect(res.status).toBe(404);
  });

  test('resolves the country code before upserting', async () => {
    supa.__push('countries', { maybeSingle: { data: { code: 'DE' }, error: null } });
    supa.__push('country_translations', { result: { data: null, error: null } });
    const app = buildApp();
    const res = await request(app).put('/admin/countries/country-1/translations').set(OWNER_AUTH).send({ translations: { en: 'Germany' } });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
  });
});

describe('POST /admin/airports', () => {
  test('requires iata_code and airport_name', async () => {
    const app = buildApp();
    const res = await request(app).post('/admin/airports').set(OWNER_AUTH).send({ airport_name: 'Munich Airport' });
    expect(res.status).toBe(400);
  });

  test('rejects a duplicate IATA code', async () => {
    supa.__push('airports', { maybeSingle: { data: { id: 'existing-1' }, error: null } });
    const app = buildApp();
    const res = await request(app).post('/admin/airports').set(OWNER_AUTH).send({ iata_code: 'MUC', airport_name: 'Munich Airport' });
    expect(res.status).toBe(409);
  });

  test('creates an airport', async () => {
    supa.__push('airports', { maybeSingle: { data: null, error: null } });
    supa.__push('airports', { maybeSingle: { data: { id: 'airport-1', iata_code: 'MUC', airport_name: 'Munich Airport' }, error: null } });
    const app = buildApp();
    const res = await request(app).post('/admin/airports').set(OWNER_AUTH).send({ iata_code: 'muc', airport_name: 'Munich Airport', latitude: 48.35, longitude: 11.78 });
    expect(res.status).toBe(200);
    expect(res.body.airport.iata_code).toBe('MUC');
  });
});

describe('DELETE /admin/airports/:id', () => {
  test('deletes an airport', async () => {
    supa.__push('airports', { result: { data: null, error: null } });
    const app = buildApp();
    const res = await request(app).delete('/admin/airports/airport-1').set(OWNER_AUTH);
    expect(res.status).toBe(200);
  });
});
