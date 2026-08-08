// [SEO-AI-OPTIMIZE] Tests for POST /admin/seo/optimize and the parser. These
// run without any network: with no ANTHROPIC_API_KEY set, the endpoint returns a
// deterministic `source: 'unavailable'` result (the caller then uses its own
// rules), which lets us assert auth + validation + graceful degradation offline.
process.env.ADMIN_TOKEN = 'test-admin-token';
delete process.env.ANTHROPIC_API_KEY; // force the deterministic no-key path

jest.mock('../src/clients/supabase', () => ({
  from: jest.fn(() => ({})),
  auth: { getUser: jest.fn() },
  __reset: () => {},
}));

const express = require('express');
const request = require('supertest');
const { parseSuggestion } = require('../src/services/seoOptimizer');

function buildApp() {
  const app = express();
  app.use(express.json());
  require('../src/routes/admin-seo.routes')(app);
  return app;
}

const OWNER_AUTH = { Authorization: 'Bearer test-admin-token' };

describe('POST /admin/seo/optimize — auth + validation', () => {
  test('rejects an unauthenticated request', async () => {
    const res = await request(buildApp()).post('/admin/seo/optimize').send({ elements: {} });
    expect(res.status).toBe(401);
  });

  test('rejects a request without page elements', async () => {
    const res = await request(buildApp()).post('/admin/seo/optimize').set(OWNER_AUTH).send({});
    expect(res.status).toBe(400);
  });

  test('degrades gracefully to source:unavailable when no ANTHROPIC key is set', async () => {
    const res = await request(buildApp()).post('/admin/seo/optimize').set(OWNER_AUTH)
      .send({ elements: { title: 't', h1: 'Flüge von Hamburg nach Barcelona', content: {}, facts: {} }, language: 'de' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.source).toBe('unavailable');
    expect(res.body.reason).toBe('no_api_key');
    // The key is never present anywhere in the response.
    expect(JSON.stringify(res.body)).not.toMatch(/x-api-key|sk-ant/i);
  });

  test('reports unsupported_language for a language the prompt will not write', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'; // present, so lang gate is what triggers
    jest.resetModules();
    const app = express();
    app.use(express.json());
    require('../src/routes/admin-seo.routes')(app);
    const res = await request(app).post('/admin/seo/optimize').set(OWNER_AUTH)
      .send({ elements: { h1: 'Vols de Paris à Nice', content: {}, facts: {} }, language: 'fr' });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('unsupported_language');
    delete process.env.ANTHROPIC_API_KEY;
    jest.resetModules();
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
