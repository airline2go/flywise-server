jest.mock('../src/clients/supabase', () => {
  const responses = {};
  function makeBuilder(table) {
    const cfg = responses[table] || {};
    const builder = {
      select: () => builder, eq: () => builder, neq: () => builder, not: () => builder,
      or: () => builder, in: () => builder, order: () => builder, range: () => builder,
      limit: () => builder, update: () => builder,
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
const { clearIndexabilityCache } = require('../src/services/indexabilityData');

function buildApp() {
  const app = express();
  app.use(express.json());
  require('../src/routes/content.routes')(app);
  return app;
}

beforeEach(() => {
  supa.__reset();
  supa.from.mockClear();
  clearIndexabilityCache();
});

describe('GET /cities', () => {
  test('returns the published city list', async () => {
    supa.__setResponse('cities', { result: { data: [{ id: 'city-1', city_slug: 'berlin', name: 'Berlin' }, { id: 'city-2', city_slug: 'paris', name: 'Paris' }], error: null } });
    supa.__setResponse('city_translations', { result: { data: [{ city_id: 'city-1', language: 'en', name: 'Berlin' }], error: null } });
    supa.__setResponse('route_pages', { result: { data: [
      { origin_city_slug: 'berlin', destination_city_slug: 'muenchen', origin_iata: 'BER', destination_iata: 'MUC', origin_country: 'DE', destination_country: 'DE', avg_duration_min: 100 },
      { origin_city_slug: 'berlin', destination_city_slug: 'paris', origin_iata: 'BER', destination_iata: 'CDG', origin_country: 'DE', destination_country: 'FR', avg_duration_min: 120 },
      { origin_city_slug: 'paris', destination_city_slug: 'madrid', origin_iata: 'CDG', destination_iata: 'MAD', origin_country: 'FR', destination_country: 'ES', avg_duration_min: 130 },
    ], error: null } });
    const app = buildApp();
    const res = await request(app).get('/cities');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, cities: [
      { city_slug: 'berlin', name: 'Berlin', airport_codes: [], translations: { en: 'Berlin' }, indexable: true },
      { city_slug: 'paris', name: 'Paris', airport_codes: [], translations: {}, indexable: true },
    ] });
  });

  test('returns an empty list rather than an error when there are no cities yet', async () => {
    supa.__setResponse('cities', { result: { data: null, error: null } });
    const res = await request(buildApp()).get('/cities');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, cities: [] });
  });

  test('surfaces a database error as a 500', async () => {
    supa.__setResponse('cities', { result: { data: null, error: { message: 'connection lost' } } });
    expect((await request(buildApp()).get('/cities')).status).toBe(500);
  });
});

describe('GET /cities/:slug', () => {
  test('404s when the city has no published routes', async () => {
    supa.__setResponse('cities', { maybeSingle: { data: { city_slug: 'nowhere', name: 'Nowhere' }, error: null } });
    supa.__setResponse('route_pages', { result: { data: [], error: null } });
    expect((await request(buildApp()).get('/cities/nowhere')).status).toBe(404);
  });
  test('returns the city plus its published routes', async () => {
    supa.__setResponse('cities', { maybeSingle: { data: { city_slug: 'berlin', name: 'Berlin' }, error: null } });
    supa.__setResponse('route_pages', { result: { data: [{ slug: 'berlin-paris' }], error: null } });
    const res = await request(buildApp()).get('/cities/berlin');
    expect(res.status).toBe(200); expect(res.body.city.city_slug).toBe('berlin'); expect(res.body.routes).toHaveLength(1);
  });
  test('[GEO-CMS] includes a language->name translations map', async () => {
    supa.__setResponse('cities', { maybeSingle: { data: { id: 'city-1', city_slug: 'berlin', name: 'Berlin' }, error: null } });
    supa.__setResponse('route_pages', { result: { data: [{ slug: 'berlin-paris' }], error: null } });
    supa.__setResponse('city_translations', { result: { data: [{ language: 'en', name: 'Berlin' }, { language: 'ar', name: 'برلين' }], error: null } });
    const res = await request(buildApp()).get('/cities/berlin');
    expect(res.status).toBe(200); expect(res.body.city.translations).toEqual({ en: 'Berlin', ar: 'برلين' });
  });
  test('[GEO-CMS] translations default to an empty object when none exist yet', async () => {
    supa.__setResponse('cities', { maybeSingle: { data: { id: 'city-1', city_slug: 'berlin', name: 'Berlin' }, error: null } });
    supa.__setResponse('route_pages', { result: { data: [{ slug: 'berlin-paris' }], error: null } });
    supa.__setResponse('city_translations', { result: { data: null, error: null } });
    const res = await request(buildApp()).get('/cities/berlin');
    expect(res.body.city.translations).toEqual({});
  });
});

describe('GET /blog-posts-en', () => {
  test('returns the published English post list', async () => {
    supa.__setResponse('blog_posts', { result: { data: [{ slug: 'hello-world', title: 'Hello World', excerpt: 'A test post.' }], error: null } });
    const res = await request(buildApp()).get('/blog-posts-en'); expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, posts: [{ slug: 'hello-world', title: 'Hello World', excerpt: 'A test post.' }] });
  });
  test('returns an empty list rather than an error when there are no English posts yet', async () => {
    supa.__setResponse('blog_posts', { result: { data: null, error: null } });
    expect((await request(buildApp()).get('/blog-posts-en')).body).toEqual({ ok: true, posts: [] });
  });
});

describe('GET /blog-posts-en/:slug', () => {
  test('404s when no post has that English slug', async () => {
    supa.__setResponse('blog_posts', { maybeSingle: { data: null, error: null } });
    expect((await request(buildApp()).get('/blog-posts-en/nowhere')).status).toBe(404);
  });
  test('returns the post remapped onto the shared field names', async () => {
    supa.__setResponse('blog_posts', { maybeSingle: { data: { id: 1, slug: 'hallo-welt', slug_en: 'hello-world', title_en: 'Hello World', content_en: '<p>Hi.</p>', meta_description_en: 'A test post.', author: 'Airpiv Team', published_at: '2026-01-01T00:00:00Z', views_count: 5 }, error: null } });
    const res = await request(buildApp()).get('/blog-posts-en/hello-world');
    expect(res.status).toBe(200); expect(res.body.post).toEqual(expect.objectContaining({ slug: 'hello-world', title: 'Hello World', content: '<p>Hi.</p>', excerpt: 'A test post.', meta_description: 'A test post.', author: 'Airpiv Team' }));
  });
});

describe('GET /countries', () => {
  test('returns the published country list', async () => {
    supa.__setResponse('countries', { result: { data: [{ code: 'DE', name: 'Deutschland' }], error: null } });
    supa.__setResponse('country_translations', { result: { data: [{ country_code: 'DE', language: 'en', name: 'Germany' }], error: null } });
    supa.__setResponse('route_pages', { result: { data: [
      { origin_city_slug: 'berlin', destination_city_slug: 'muenchen', origin_iata: 'BER', destination_iata: 'MUC', origin_country: 'DE', destination_country: 'DE', avg_duration_min: 100 },
      { origin_city_slug: 'berlin', destination_city_slug: 'paris', origin_iata: 'BER', destination_iata: 'CDG', origin_country: 'DE', destination_country: 'FR', avg_duration_min: 120 },
    ], error: null } });
    const res = await request(buildApp()).get('/countries');
    expect(res.status).toBe(200); expect(res.body).toEqual({ ok: true, countries: [{ code: 'DE', name: 'Deutschland', translations: { en: 'Germany' }, indexable: true }] });
  });
});

describe('GET /countries/:code', () => {
  test('404s when the country has no published routes', async () => {
    supa.__setResponse('countries', { maybeSingle: { data: { code: 'DE', name: 'Deutschland' }, error: null } });
    supa.__setResponse('route_pages', { result: { data: [], error: null } });
    expect((await request(buildApp()).get('/countries/DE')).status).toBe(404);
  });
  test('[GEO-CMS] returns the country plus a translations map', async () => {
    supa.__setResponse('countries', { maybeSingle: { data: { code: 'DE', name: 'Deutschland' }, error: null } });
    supa.__setResponse('route_pages', { result: { data: [{ slug: 'berlin-paris' }], error: null } });
    supa.__setResponse('country_translations', { result: { data: [{ language: 'en', name: 'Germany' }, { language: 'es', name: 'Alemania' }], error: null } });
    const res = await request(buildApp()).get('/countries/de');
    expect(res.status).toBe(200); expect(res.body.country.code).toBe('DE'); expect(res.body.country.translations).toEqual({ en: 'Germany', es: 'Alemania' });
  });
});
