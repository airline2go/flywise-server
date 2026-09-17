jest.mock('../src/clients/supabase', () => {
  const responses = {};
  function makeBuilder(table) {
    const cfg = responses[table] || {};
    const builder = {
      select: () => builder,
      eq: () => builder,
      not: () => builder,
      order: () => builder,
      range: () => builder,
      in: () => builder,
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

function buildApp() {
  const app = express();
  require('../src/routes/localized-sitemap.routes')(app);
  return app;
}

beforeEach(() => { supa.__reset(); supa.from.mockClear(); });

test('uses the freshest route or locale timestamp for localized lastmod', async () => {
  supa.__setResponse('route_seo_locales', {
    result: {
      data: [{
        route_page_id: 'route-1',
        language: 'en',
        seo_generated_at: '2026-09-10T00:00:00Z',
        updated_at: '2026-09-11T00:00:00Z',
      }],
      error: null,
    },
  });
  supa.__setResponse('route_pages', {
    result: {
      data: [{
        id: 'route-1',
        slug: 'alicante-barcelona',
        status: 'published',
        updated_at: '2026-09-04T00:00:00Z',
        insights_updated_at: '2026-09-17T19:28:28.353Z',
        created_at: '2026-01-01T00:00:00Z',
      }],
      error: null,
    },
  });

  const res = await request(buildApp()).get('/sitemap-data/routes-localized?lang=en');
  expect(res.status).toBe(200);
  expect(res.body.items).toEqual([{
    id: 'alicante-barcelona',
    language: 'en',
    lastmod: '2026-09-17',
  }]);
});

test('accepts a bounded slug set for recovery sitemap discovery', async () => {
  supa.__setResponse('route_pages', {
    result: {
      data: [{
        id: 'route-1',
        slug: 'alicante-barcelona',
        status: 'published',
      }],
      error: null,
    },
  });
  supa.__setResponse('route_seo_locales', {
    result: {
      data: [{
        route_page_id: 'route-1',
        language: 'en',
        seo_generated_at: '2026-09-16T00:00:00Z',
        updated_at: '2026-09-16T12:00:00Z',
      }],
      error: null,
    },
  });

  const res = await request(buildApp())
    .get('/sitemap-data/routes-localized?lang=en&slugs=alicante-barcelona');

  expect(res.status).toBe(200);
  expect(res.body.hasMore).toBe(false);
  expect(res.body.items).toEqual([{
    id: 'alicante-barcelona',
    language: 'en',
    lastmod: '2026-09-16',
  }]);
  expect(supa.from).toHaveBeenCalledWith('route_pages');
  expect(supa.from).toHaveBeenCalledWith('route_seo_locales');
});

test('rejects more than 100 requested slugs', async () => {
  const slugs = Array.from({ length: 101 }, (_, i) => `route-${i}`).join(',');
  const res = await request(buildApp()).get(`/sitemap-data/routes-localized?lang=en&slugs=${slugs}`);
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('slugs limit exceeded');
});
