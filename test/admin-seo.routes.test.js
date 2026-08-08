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

jest.mock('../src/utils/triggerRebuild');

const express = require('express');
const request = require('supertest');
const supa = require('../src/clients/supabase');
const env = require('../src/config/env');
const triggerRebuild = require('../src/utils/triggerRebuild');
const { parseSuggestion, normalizeSuggestion, generateRouteOptimization } = require('../src/services/seoOptimizer');
const { buildSeoPatch, parseContentBlock } = require('../src/services/seoApply');

function buildApp() {
  const app = express();
  app.use(express.json());
  require('../src/routes/admin-seo.routes')(app);
  return app;
}

const OWNER_AUTH = { Authorization: 'Bearer test-admin-token' };

beforeEach(() => { supa.__reset(); supa.from.mockClear(); triggerRebuild.mockClear(); });

const APPROVED_OPT = {
  id: 'o1', slug: 'hamburg-barcelona', language: 'de', status: 'approved',
  suggestions: {
    title: { changeRecommended: true, proposed: 'Hamburg → Barcelona: Flugzeit | Airpiv' },
    meta: { changeRecommended: false, proposed: null },
    content: { changeRecommended: true, proposed: 'Kurzer Intro-Text zur Strecke.\n\nQ: Wie lange dauert der Flug?\nA: Etwa 2h 20min.' },
  },
};
const ROUTE_ROW = { id: 'rp1', slug: 'hamburg-barcelona', seo_title: 'alt', seo_meta_description: 'alt-meta', seo_intro_html: null, seo_faq: null, seo_lang: 'de' };

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

describe('POST /admin/seo/optimizations — store a client-provided suggestion', () => {
  test('rejects without a slug or suggestions', async () => {
    const r1 = await request(buildApp()).post('/admin/seo/optimizations').set(OWNER_AUTH).send({ suggestions: {} });
    expect(r1.status).toBe(400);
    const r2 = await request(buildApp()).post('/admin/seo/optimizations').set(OWNER_AUTH).send({ slug: 'hamburg-barcelona' });
    expect(r2.status).toBe(400);
  });

  test('stores a rules suggestion and returns its id', async () => {
    supa.__push('seo_route_optimizations', { single: { data: { id: 'o9' }, error: null } });
    const res = await request(buildApp()).post('/admin/seo/optimizations').set(OWNER_AUTH)
      .send({ slug: 'hamburg-barcelona', language: 'de', source: 'rules', suggestions: { title: { proposed: 'X | Airpiv', changeRecommended: true } } });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('o9');
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

describe('buildSeoPatch / parseContentBlock — only proposed fields, safe HTML', () => {
  test('writes only the fields with a real proposed change', () => {
    const { patch, changedKeys } = buildSeoPatch(APPROVED_OPT.suggestions);
    expect(patch.seo_title).toBe('Hamburg → Barcelona: Flugzeit | Airpiv');
    expect(patch.seo_meta_description).toBeUndefined(); // meta not proposed → untouched
    expect(patch.seo_intro_html).toMatch(/^<p>/);
    expect(patch.seo_faq).toEqual([{ question: 'Wie lange dauert der Flug?', answer: 'Etwa 2h 20min.' }]);
    expect(changedKeys).toContain('seo_title');
  });

  test('empty patch when nothing is proposed', () => {
    const { changedKeys } = buildSeoPatch({ title: { changeRecommended: false, proposed: null }, meta: {}, content: {} });
    expect(changedKeys).toHaveLength(0);
  });

  test('parseContentBlock escapes HTML and splits FAQ pairs', () => {
    const { introHtml, faq } = parseContentBlock('Intro <script>x</script>\n\nQ: A?\nA: B.');
    expect(introHtml).toContain('&lt;script&gt;'); // no raw markup injected
    expect(faq).toEqual([{ question: 'A?', answer: 'B.' }]);
  });
});

describe('POST /admin/seo/optimizations/:id/apply — write + revalidate', () => {
  test('rejects unauthenticated', async () => {
    const res = await request(buildApp()).post('/admin/seo/optimizations/o1/apply');
    expect(res.status).toBe(401);
  });

  test('applies an APPROVED optimization, writes seo_* + captures old values, revalidates', async () => {
    supa.__push('seo_route_optimizations', { maybeSingle: { data: APPROVED_OPT, error: null } });   // getOptimization
    supa.__push('route_pages', { maybeSingle: { data: ROUTE_ROW, error: null } });                   // fetch current
    supa.__push('route_pages', { result: { data: null, error: null } });                             // update (atomic)
    supa.__push('seo_route_optimizations', { maybeSingle: { data: { ...APPROVED_OPT, status: 'applied' }, error: null } }); // audit
    const res = await request(buildApp()).post('/admin/seo/optimizations/o1/apply').set(OWNER_AUTH);
    expect(res.status).toBe(200);
    expect(res.body.optimization.status).toBe('applied');
    expect(res.body.oldValues.seo_title).toBe('alt');            // previous value captured
    expect(res.body.newValues.seo_title).toBe('Hamburg → Barcelona: Flugzeit | Airpiv');
    expect(triggerRebuild).toHaveBeenCalledWith([{ type: 'route', slug: 'hamburg-barcelona' }]);
  });

  test('refuses to apply a non-APPROVED optimization', async () => {
    supa.__push('seo_route_optimizations', { maybeSingle: { data: { ...APPROVED_OPT, status: 'generated' }, error: null } });
    const res = await request(buildApp()).post('/admin/seo/optimizations/o1/apply').set(OWNER_AUTH);
    expect(res.status).toBe(409);
    expect(triggerRebuild).not.toHaveBeenCalled();
  });

  test('a DB write failure aborts before the status flips to applied', async () => {
    supa.__push('seo_route_optimizations', { maybeSingle: { data: APPROVED_OPT, error: null } });
    supa.__push('route_pages', { maybeSingle: { data: ROUTE_ROW, error: null } });
    supa.__push('route_pages', { result: { data: null, error: { message: 'boom' } } }); // update fails
    const res = await request(buildApp()).post('/admin/seo/optimizations/o1/apply').set(OWNER_AUTH);
    expect(res.status).toBe(500);
    expect(triggerRebuild).not.toHaveBeenCalled();
  });
});

describe('POST /admin/seo/optimizations/:id/rollback — restore previous values', () => {
  const APPLIED = { id: 'o1', slug: 'hamburg-barcelona', status: 'applied', route_page_id: 'rp1', applied_old_values: { seo_title: 'alt', seo_meta_description: 'alt-meta', seo_intro_html: null, seo_faq: null, seo_lang: 'de' } };

  test('restores the exact captured values and marks rolled_back', async () => {
    supa.__push('seo_route_optimizations', { maybeSingle: { data: APPLIED, error: null } });     // getOptimization
    supa.__push('route_pages', { result: { data: null, error: null } });                          // restore write
    supa.__push('seo_route_optimizations', { maybeSingle: { data: { ...APPLIED, status: 'rolled_back' }, error: null } });
    const res = await request(buildApp()).post('/admin/seo/optimizations/o1/rollback').set(OWNER_AUTH).send({ reason: 'worse CTR' });
    expect(res.status).toBe(200);
    expect(res.body.optimization.status).toBe('rolled_back');
    expect(triggerRebuild).toHaveBeenCalledWith([{ type: 'route', slug: 'hamburg-barcelona' }]);
  });

  test('refuses to roll back something not APPLIED', async () => {
    supa.__push('seo_route_optimizations', { maybeSingle: { data: { ...APPLIED, status: 'approved' }, error: null } });
    const res = await request(buildApp()).post('/admin/seo/optimizations/o1/rollback').set(OWNER_AUTH);
    expect(res.status).toBe(409);
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

  test('normalizeSuggestion accepts a structured object (tool_use.input path)', () => {
    const input = {
      cities: { origin: 'Hamburg', destination: 'Barcelona' },
      opportunity: true,
      dominantIntent: 'duration',
      title: { proposed: 'T | Airpiv', changeRecommended: true, reason: 'r' },
      meta: { proposed: null, changeRecommended: false, reason: 'r' },
      h1: { proposed: null, changeRecommended: false, reason: 'r' },
      content: { proposed: 'intro\n\nQ: a?\nA: b.', changeRecommended: true, reason: 'r', factsUsed: ['distance: 1.100 km'] },
    };
    const out = normalizeSuggestion(input);
    expect(out.cities).toEqual({ origin: 'Hamburg', destination: 'Barcelona' });
    expect(out.title.proposed).toBe('T | Airpiv');
    expect(out.content.current).toBeNull(); // content has no single "current" to diff
    expect(out.content.factsUsed).toContain('distance: 1.100 km');
  });

  test('recovers JSON wrapped in prose or an unclosed fence', () => {
    const obj = { cities: { origin: 'Berlin', destination: 'Rom' }, opportunity: false, title: { proposed: 'X | Airpiv', changeRecommended: true } };
    const withProse = `Sure! Here is the JSON you asked for:\n\n${JSON.stringify(obj)}\n\nLet me know if you need changes.`;
    const out = parseSuggestion(withProse);
    expect(out.cities).toEqual({ origin: 'Berlin', destination: 'Rom' });
    expect(out.title.proposed).toBe('X | Airpiv');
    // A leftover ```json fence without a closing fence still parses.
    const fenced = '```json\n' + JSON.stringify(obj);
    expect(parseSuggestion(fenced).title.changeRecommended).toBe(true);
  });
});
