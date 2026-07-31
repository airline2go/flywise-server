// Tests for the dedicated paginated sitemap-data endpoints: indexable-only
// filtering, lean { id, lastmod } items, and the hasMore paging signal.
jest.mock('../src/clients/supabase', () => {
  const responses = {};
  function makeBuilder(table) {
    const cfg = responses[table] || {};
    const builder = {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
      order: () => builder,
      range: () => builder,
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

const express = require('express');
const request = require('supertest');
const supa = require('../src/clients/supabase');
const { clearIndexabilityCache } = require('../src/services/indexabilityData');

function buildApp() {
  const app = express();
  app.use(express.json());
  require('../src/routes/sitemap.routes')(app);
  return app;
}

beforeEach(() => {
  supa.__reset();
  supa.from.mockClear();
  clearIndexabilityCache();
});

describe('GET /sitemap-data/routes', () => {
  test('returns only indexable routes, lean {id,lastmod,o,d}', async () => {
    supa.__setResponse('route_pages', { result: { data: [
      { slug: 'ber-muc', distance_km: 500, updated_at: '2026-05-01T00:00:00Z', origin_iata: 'BER', destination_iata: 'MUC' },
      { slug: 'thin-xx', origin_iata: 'XXX', destination_iata: 'YYY' }, // no data, no admin → excluded
    ], error: null } });
    const res = await request(buildApp()).get('/sitemap-data/routes');
    expect(res.status).toBe(200);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.items).toEqual([{ id: 'ber-muc', lastmod: '2026-05-01', o: 'BER', d: 'MUC' }]);
  });

  test('page query is parsed and echoed', async () => {
    supa.__setResponse('route_pages', { result: { data: [], error: null } });
    const res = await request(buildApp()).get('/sitemap-data/routes?page=3');
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(3);
    expect(res.body.items).toEqual([]);
  });
});

describe('GET /sitemap-data/cities', () => {
  test('excludes a thin city (≤1 distinct destination, no intro)', async () => {
    supa.__setResponse('cities', { result: { data: [
      { city_slug: 'berlin', created_at: '2026-01-01T00:00:00Z' },
      { city_slug: 'lonely', created_at: '2026-01-02T00:00:00Z' },
    ], error: null } });
    // Connectivity: berlin reaches muenchen+paris (2 → indexable); lonely reaches only muenchen (1 → thin).
    supa.__setResponse('route_pages', { result: { data: [
      { origin_city_slug: 'berlin', destination_city_slug: 'muenchen', origin_iata: 'BER', destination_iata: 'MUC', origin_country: 'DE', destination_country: 'DE' },
      { origin_city_slug: 'berlin', destination_city_slug: 'paris', origin_iata: 'BER', destination_iata: 'CDG', origin_country: 'DE', destination_country: 'FR' },
      { origin_city_slug: 'lonely', destination_city_slug: 'muenchen', origin_iata: 'LNL', destination_iata: 'MUC', origin_country: 'DE', destination_country: 'DE' },
    ], error: null } });
    supa.__setResponse('route_airlines', { result: { data: [], error: null } });
    const res = await request(buildApp()).get('/sitemap-data/cities');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([{ id: 'berlin', lastmod: '2026-01-01' }]);
  });
});

describe('GET /sitemap-data/countries', () => {
  test('includes a country whose connectivity score ≥2', async () => {
    supa.__setResponse('countries', { result: { data: [{ code: 'DE', created_at: '2026-01-01T00:00:00Z' }], error: null } });
    supa.__setResponse('route_pages', { result: { data: [
      { origin_city_slug: 'berlin', destination_city_slug: 'muenchen', origin_iata: 'BER', destination_iata: 'MUC', origin_country: 'DE', destination_country: 'DE' },
      { origin_city_slug: 'berlin', destination_city_slug: 'paris', origin_iata: 'BER', destination_iata: 'CDG', origin_country: 'DE', destination_country: 'FR' },
    ], error: null } });
    supa.__setResponse('route_airlines', { result: { data: [], error: null } });
    const res = await request(buildApp()).get('/sitemap-data/countries');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([{ id: 'DE', lastmod: '2026-01-01' }]);
  });
});

describe('GET /sitemap-data/airlines', () => {
  test('includes an airline operating ≥2 published routes', async () => {
    supa.__setResponse('airlines', { result: { data: [
      { id: 1, iata_code: 'LH', created_at: '2026-01-01T00:00:00Z' },
      { id: 2, iata_code: 'ZZ', created_at: '2026-01-02T00:00:00Z' },
    ], error: null } });
    supa.__setResponse('route_pages', { result: { data: [
      { origin_iata: 'BER', destination_iata: 'MUC', origin_city_slug: 'berlin', destination_city_slug: 'muenchen', origin_country: 'DE', destination_country: 'DE' },
      { origin_iata: 'BER', destination_iata: 'CDG', origin_city_slug: 'berlin', destination_city_slug: 'paris', origin_country: 'DE', destination_country: 'FR' },
    ], error: null } });
    supa.__setResponse('route_airlines', { result: { data: [
      { airline_id: 1, route_origin_iata: 'BER', route_destination_iata: 'MUC' },
      { airline_id: 1, route_origin_iata: 'BER', route_destination_iata: 'CDG' },
      { airline_id: 2, route_origin_iata: 'BER', route_destination_iata: 'MUC' }, // only 1 → thin
    ], error: null } });
    const res = await request(buildApp()).get('/sitemap-data/airlines');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([{ id: 'LH', lastmod: '2026-01-01' }]);
  });
});

describe('GET /sitemap-data/blog', () => {
  test('German posts: lean {id,lastmod}, newest of updated/published', async () => {
    supa.__setResponse('blog_posts', { result: { data: [
      { slug: 'my-post', updated_at: '2026-03-01T00:00:00Z', published_at: '2026-02-01T00:00:00Z' },
    ], error: null } });
    const res = await request(buildApp()).get('/sitemap-data/blog');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([{ id: 'my-post', lastmod: '2026-03-01' }]);
  });
});
