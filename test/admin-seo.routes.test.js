// [SEO-AI-OPTIMIZE] Tests for /admin/seo/* and the parser. These run without any
// network: with no ANTHROPIC_API_KEY the optimize endpoint returns a
// deterministic `source: 'unavailable'`, and the history/status endpoints run
// against a mocked Supabase — so we can assert auth, validation, storage
// wiring, and graceful degradation entirely offline.
process.env.ADMIN_TOKEN = 'test-admin-token';
delete process.env.ANTHROPIC_API_KEY; // force the deterministic no-key path

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
      insert: () => builder,
      update: () => builder,
      delete: () => builder,
      single: () => Promise.resolve(cfg.single || { data: null, error: null }),
      maybeSingle: () => Promise.resolve(cfg.maybeSingle || { data: null, error: null }),
      then: (resolve, reject) => Promise.resolve(cfg.result || { data: cfg.data || null, error: null }).then(resolve, reject),
    };
    return builder;
  }
  return {
    from: jest.fn((table) => makeBuilder(table)),
    auth: { getUser: jest.fn() },
    __push: (table, cfg) => { (queues[table] = queues[table] || []).push(cfg); },
    __reset: () => { for (const k of Object.keys(queues)) delete queues[k]; },
  };
});

const express = require('express');
const request = require('supertest');
const supa = require('../src/clients/supabase');
const env = require('../src/config/env');
const { parseSuggestion, generateRouteOptimization } = require('../src/services/seoOptimizer');

function buildApp() {
  const app = express();
  app.use(express.json());
  require('../src/routes/admin-seo.routes')(app);
  return app;
}

const OWNER_AUTH = { Authorization: 'Bearer test-admin-token' };

beforeEach(() => { supa.__reset(); supa.from.mockClear(); });

describe('POST /admin/seo/optimize — auth + validation + degradation', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await request(buildApp()).post('/admin/seo/optimize').send({ elements: {} });
    expect(res.status).toBe(401);
  });

  test('rejects a request without page elements', async () => {
    const res = await request(buildApp()).post('/admin/seo/optimize').set(OWNER_AUTH).send({});
    expect(res.status).toBe(400);
  });

  test('degrades to source:unavailable (and stores nothing) when no ANTHROPIC key is set', async () => {
    const res = await request(buildApp()).post('/admin/seo/optimize').set(OWNER_AUTH)
      .send({ slug: 'hamburg-barcelona', elements: { title: 't', h1: 'Flüge von Hamburg nach Barcelona', content: {}, facts: {} }, language: 'de' });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('unavailable');
    expect(res.body.id).toBeNull(); // nothing stored on the degraded path
    expect(JSON.stringify(res.body)).not.toMatch(/x-api-key|sk-ant/i);
  });

  test('reports unsupported_language for a language the prompt will not write', async () => {
    // Service-level (the service reads env.ANTHROPIC_API_KEY per call, so a key
    // must be present for the language gate to be the thing that trips — no
    // network happens because the gate returns before any fetch).
    env.ANTHROPIC_API_KEY = 'sk-test-key';
    try {
      const r = await generateRouteOptimization({ elements: { h1: 'Vols de Paris à Nice', content: {}, facts: {} }, gsc: null, dominantIntent: null, language: 'fr' });
      expect(r.source).toBe('unsupported_language');
    } finally {
      env.ANTHROPIC_API_KEY = undefined;
    }
  });
});

describe('GET /admin/seo/optimizations — history', () => {
  test('requires a valid slug', async () => {
    const res = await request(buildApp()).get('/admin/seo/optimizations').set(OWNER_AUTH);
    expect(res.status).toBe(400);
  });

  test('returns the route\'s stored optimizations newest-first', async () => {
    supa.__push('seo_route_optimizations', { result: { data: [{ id: 'o1', slug: 'hamburg-barcelona', status: 'generated', source: 'ai' }], error: null } });
    const res = await request(buildApp()).get('/admin/seo/optimizations?slug=hamburg-barcelona&language=de').set(OWNER_AUTH);
    expect(res.status).toBe(200);
    expect(res.body.optimizations).toHaveLength(1);
    expect(res.body.optimizations[0].id).toBe('o1');
  });
});

describe('PATCH /admin/seo/optimizations/:id — review lifecycle', () => {
  test('rejects an invalid status', async () => {
    const res = await request(buildApp()).patch('/admin/seo/optimizations/o1').set(OWNER_AUTH).send({ status: 'bogus' });
    expect(res.status).toBe(400);
  });

  test('approves a stored optimization and returns the updated row', async () => {
    supa.__push('seo_route_optimizations', { maybeSingle: { data: { id: 'o1', status: 'approved', approved_at: new Date().toISOString() }, error: null } });
    const res = await request(buildApp()).patch('/admin/seo/optimizations/o1').set(OWNER_AUTH).send({ status: 'approved' });
    expect(res.status).toBe(200);
    expect(res.body.optimization.status).toBe('approved');
  });

  test('404 when the optimization id is unknown', async () => {
    supa.__push('seo_route_optimizations', { maybeSingle: { data: null, error: null } });
    const res = await request(buildApp()).patch('/admin/seo/optimizations/missing').set(OWNER_AUTH).send({ status: 'reviewed' });
    expect(res.status).toBe(404);
  });
});

describe('parseSuggestion — tolerant + non-fabricating', () => {
  test('parses a fenced JSON reply into the canonical shape', () => {
    const reply = '```json\n' + JSON.stringify({
      cities: { origin: 'Hamburg', destination: 'Barcelona' },
      opportunity: true,
      dominantIntent: 'duration',
      title: { current: 'x', proposed: 'Hamburg → Barcelona: Flugzeit | Airpiv', changeRecommended: true, reason: 'r' },
      meta: { current: null, proposed: null, changeRecommended: false, reason: 'r' },
      h1: { current: 'H', proposed: null, changeRecommended: false, reason: 'r' },
      content: { current: null, proposed: 'intro', changeRecommended: true, reason: 'r', factsUsed: ['distance: 1.100 km'] },
    }) + '\n```';
    const out = parseSuggestion(reply);
    expect(out.cities).toEqual({ origin: 'Hamburg', destination: 'Barcelona' });
    expect(out.title.changeRecommended).toBe(true);
    expect(out.content.current).toBeNull();
    expect(out.content.factsUsed).toContain('distance: 1.100 km');
  });

  test('returns null on non-JSON, and null cities when the model omits them', () => {
    expect(parseSuggestion('not json at all')).toBeNull();
    const out = parseSuggestion(JSON.stringify({ opportunity: false, title: {}, meta: {}, h1: {}, content: {} }));
    expect(out.cities).toBeNull(); // never fabricated
    expect(out.title.proposed).toBeNull();
  });
});
