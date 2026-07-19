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
jest.mock('../src/utils/triggerRebuild');

const express = require('express');
const request = require('supertest');
const supa = require('../src/clients/supabase');
const triggerRebuild = require('../src/utils/triggerRebuild');

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
  triggerRebuild.mockClear();
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

describe('PUT /admin/airports/:id — [ROUTE-INTELLIGENCE-3] traveler info fields', () => {
  test('accepts and passes through distance_to_city_center_km/transit_options/terminal_info/traveler_tips', async () => {
    supa.__push('airports', {
      maybeSingle: {
        data: {
          id: 'airport-1', iata_code: 'MUC', distance_to_city_center_km: 28.5,
          transit_options: 'Train every 20 minutes', terminal_info: 'Two terminals, T1 and T2',
          traveler_tips: 'Arrive 2 hours early for international flights',
        },
        error: null,
      },
    });
    const app = buildApp();
    const res = await request(app).put('/admin/airports/airport-1').set(OWNER_AUTH).send({
      distance_to_city_center_km: '28.5',
      transit_options: 'Train every 20 minutes',
      terminal_info: 'Two terminals, T1 and T2',
      traveler_tips: 'Arrive 2 hours early for international flights',
    });
    expect(res.status).toBe(200);
    expect(res.body.airport.distance_to_city_center_km).toBe(28.5);
    expect(res.body.airport.transit_options).toBe('Train every 20 minutes');
  });

  test('an empty string clears a previously-set field back to null', async () => {
    supa.__push('airports', { maybeSingle: { data: { id: 'airport-1', iata_code: 'MUC', traveler_tips: null }, error: null } });
    const app = buildApp();
    const res = await request(app).put('/admin/airports/airport-1').set(OWNER_AUTH).send({ traveler_tips: '' });
    expect(res.status).toBe(200);
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

describe('[ON-DEMAND-REVALIDATE] airport edits refresh the airport page', () => {
  test('creating a published airport triggers a rebuild for that airport', async () => {
    supa.__push('airports', { maybeSingle: { data: null, error: null } }); // dup check → none
    supa.__push('airports', { maybeSingle: { data: { id: '1', iata_code: 'MUC', status: 'published' }, error: null } });
    const app = buildApp();
    await request(app).post('/admin/airports').set(OWNER_AUTH).send({ iata_code: 'MUC', airport_name: 'Munich' });
    expect(triggerRebuild).toHaveBeenCalledWith([{ type: 'airport', slug: 'MUC' }]);
  });

  test('creating a DRAFT airport does NOT trigger a rebuild', async () => {
    supa.__push('airports', { maybeSingle: { data: null, error: null } });
    supa.__push('airports', { maybeSingle: { data: { id: '1', iata_code: 'MUC', status: 'draft' }, error: null } });
    const app = buildApp();
    await request(app).post('/admin/airports').set(OWNER_AUTH).send({ iata_code: 'MUC', airport_name: 'Munich', status: 'draft' });
    expect(triggerRebuild).not.toHaveBeenCalled();
  });

  test('updating a published airport triggers a rebuild', async () => {
    supa.__push('airports', { maybeSingle: { data: { id: '1', iata_code: 'BER', status: 'published' }, error: null } });
    const app = buildApp();
    await request(app).put('/admin/airports/1').set(OWNER_AUTH).send({ airport_name: 'Berlin Brandenburg' });
    expect(triggerRebuild).toHaveBeenCalledWith([{ type: 'airport', slug: 'BER' }]);
  });

  test('deleting a published airport triggers a rebuild for the removed page', async () => {
    supa.__push('airports', { maybeSingle: { data: { iata_code: 'HAM', status: 'published' }, error: null } });
    supa.__push('airports', { result: { data: null, error: null } });
    const app = buildApp();
    await request(app).delete('/admin/airports/1').set(OWNER_AUTH);
    expect(triggerRebuild).toHaveBeenCalledWith([{ type: 'airport', slug: 'HAM' }]);
  });

  test('editing translations of a published airport triggers a rebuild', async () => {
    supa.__push('airport_translations', { result: { data: null, error: null } }); // upsert
    supa.__push('airports', { maybeSingle: { data: { iata_code: 'CGN', status: 'published' }, error: null } });
    const app = buildApp();
    await request(app).put('/admin/airports/1/translations').set(OWNER_AUTH).send({ translations: { en: 'Cologne Bonn' } });
    expect(triggerRebuild).toHaveBeenCalledWith([{ type: 'airport', slug: 'CGN' }]);
  });
});

describe('[ON-DEMAND-REVALIDATE] city edits refresh the city page', () => {
  test('creating a published city triggers a rebuild for that city', async () => {
    supa.__push('cities', { maybeSingle: { data: { id: '1', city_slug: 'munich', status: 'published' }, error: null } });
    const app = buildApp();
    await request(app).post('/admin/cities').set(OWNER_AUTH).send({ city_slug: 'munich', name: 'München' });
    expect(triggerRebuild).toHaveBeenCalledWith([{ type: 'city', slug: 'munich' }]);
  });

  test('creating a DRAFT city does NOT trigger a rebuild', async () => {
    supa.__push('cities', { maybeSingle: { data: { id: '1', city_slug: 'munich', status: 'draft' }, error: null } });
    const app = buildApp();
    await request(app).post('/admin/cities').set(OWNER_AUTH).send({ city_slug: 'munich', name: 'München', status: 'draft' });
    expect(triggerRebuild).not.toHaveBeenCalled();
  });

  test('updating a published city triggers a rebuild', async () => {
    supa.__push('cities', { maybeSingle: { data: { id: '1', city_slug: 'berlin', status: 'published' }, error: null } });
    const app = buildApp();
    await request(app).put('/admin/cities/1').set(OWNER_AUTH).send({ name: 'Berlin' });
    expect(triggerRebuild).toHaveBeenCalledWith([{ type: 'city', slug: 'berlin' }]);
  });

  test('deleting a published city triggers a rebuild for the removed page', async () => {
    supa.__push('cities', { maybeSingle: { data: { city_slug: 'hamburg', status: 'published' }, error: null } });
    supa.__push('cities', { result: { data: null, error: null } });
    const app = buildApp();
    await request(app).delete('/admin/cities/1').set(OWNER_AUTH);
    expect(triggerRebuild).toHaveBeenCalledWith([{ type: 'city', slug: 'hamburg' }]);
  });

  test('editing translations of a published city triggers a rebuild', async () => {
    supa.__push('city_translations', { result: { data: null, error: null } }); // upsert
    supa.__push('cities', { maybeSingle: { data: { city_slug: 'cologne', status: 'published' }, error: null } });
    const app = buildApp();
    await request(app).put('/admin/cities/1/translations').set(OWNER_AUTH).send({ translations: { en: 'Cologne' } });
    expect(triggerRebuild).toHaveBeenCalledWith([{ type: 'city', slug: 'cologne' }]);
  });
});

describe('[ON-DEMAND-REVALIDATE] country edits refresh the country page', () => {
  test('creating a published country triggers a rebuild for that country', async () => {
    supa.__push('countries', { maybeSingle: { data: { id: '1', code: 'ES', status: 'published' }, error: null } });
    const app = buildApp();
    await request(app).post('/admin/countries').set(OWNER_AUTH).send({ code: 'ES', name: 'Spain' });
    expect(triggerRebuild).toHaveBeenCalledWith([{ type: 'country', slug: 'ES' }]);
  });

  test('creating a DRAFT country does NOT trigger a rebuild', async () => {
    supa.__push('countries', { maybeSingle: { data: { id: '1', code: 'ES', status: 'draft' }, error: null } });
    const app = buildApp();
    await request(app).post('/admin/countries').set(OWNER_AUTH).send({ code: 'ES', name: 'Spain', status: 'draft' });
    expect(triggerRebuild).not.toHaveBeenCalled();
  });

  test('updating a published country triggers a rebuild', async () => {
    supa.__push('countries', { maybeSingle: { data: { id: '1', code: 'FR', status: 'published' }, error: null } });
    const app = buildApp();
    await request(app).put('/admin/countries/1').set(OWNER_AUTH).send({ name: 'France' });
    expect(triggerRebuild).toHaveBeenCalledWith([{ type: 'country', slug: 'FR' }]);
  });

  test('deleting a published country triggers a rebuild for the removed page', async () => {
    supa.__push('countries', { maybeSingle: { data: { code: 'IT', status: 'published' }, error: null } });
    supa.__push('countries', { result: { data: null, error: null } });
    const app = buildApp();
    await request(app).delete('/admin/countries/1').set(OWNER_AUTH);
    expect(triggerRebuild).toHaveBeenCalledWith([{ type: 'country', slug: 'IT' }]);
  });

  test('editing translations of a published country triggers a rebuild', async () => {
    supa.__push('countries', { maybeSingle: { data: { code: 'NL', status: 'published' }, error: null } });
    supa.__push('country_translations', { result: { data: null, error: null } }); // upsert
    const app = buildApp();
    await request(app).put('/admin/countries/1/translations').set(OWNER_AUTH).send({ translations: { en: 'Netherlands' } });
    expect(triggerRebuild).toHaveBeenCalledWith([{ type: 'country', slug: 'NL' }]);
  });
});
