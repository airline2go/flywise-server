jest.mock('../src/clients/supabase', () => {
  const responses = {}; // table -> { result }
  function makeBuilder(table) {
    const cfg = responses[table] || {};
    const builder = {
      select: () => builder,
      eq: () => builder,
      neq: () => builder,
      or: () => builder,
      order: () => builder,
      limit: () => builder,
      update: () => builder,
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

jest.mock('../src/utils/log', () => jest.fn());

const express = require('express');
const request = require('supertest');
const supa = require('../src/clients/supabase');

function buildApp() {
  const app = express();
  app.use(express.json());
  require('../src/routes/content.routes')(app);
  return app;
}

beforeEach(() => {
  supa.__reset();
  supa.from.mockClear();
});

describe('GET /cities', () => {
  test('returns the published city list', async () => {
    supa.__setResponse('cities', { result: { data: [{ city_slug: 'berlin', name: 'Berlin' }, { city_slug: 'paris', name: 'Paris' }], error: null } });
    const app = buildApp();
    const res = await request(app).get('/cities');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, cities: [{ city_slug: 'berlin', name: 'Berlin' }, { city_slug: 'paris', name: 'Paris' }] });
  });

  test('returns an empty list rather than an error when there are no cities yet', async () => {
    supa.__setResponse('cities', { result: { data: null, error: null } });
    const app = buildApp();
    const res = await request(app).get('/cities');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, cities: [] });
  });

  test('surfaces a database error as a 500', async () => {
    supa.__setResponse('cities', { result: { data: null, error: { message: 'connection lost' } } });
    const app = buildApp();
    const res = await request(app).get('/cities');
    expect(res.status).toBe(500);
  });
});

describe('GET /cities/:slug', () => {
  test('404s when the city has no published routes', async () => {
    supa.__setResponse('cities', { maybeSingle: { data: { city_slug: 'nowhere', name: 'Nowhere' }, error: null } });
    supa.__setResponse('route_pages', { result: { data: [], error: null } });
    const app = buildApp();
    const res = await request(app).get('/cities/nowhere');
    expect(res.status).toBe(404);
  });

  test('returns the city plus its published routes', async () => {
    supa.__setResponse('cities', { maybeSingle: { data: { city_slug: 'berlin', name: 'Berlin' }, error: null } });
    supa.__setResponse('route_pages', { result: { data: [{ slug: 'berlin-paris' }], error: null } });
    const app = buildApp();
    const res = await request(app).get('/cities/berlin');
    expect(res.status).toBe(200);
    expect(res.body.city.city_slug).toBe('berlin');
    expect(res.body.routes).toHaveLength(1);
  });
});

describe('GET /countries', () => {
  test('returns the published country list', async () => {
    supa.__setResponse('countries', { result: { data: [{ code: 'DE', name: 'Deutschland' }], error: null } });
    const app = buildApp();
    const res = await request(app).get('/countries');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, countries: [{ code: 'DE', name: 'Deutschland' }] });
  });
});
