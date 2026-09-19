process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.SEARCH_SESSION_SECRET = 'test-search-session-secret';
process.env.DUFFEL_TOKEN = 'test-token';

jest.mock('../src/clients/supabase', () => {
  const responses = {};
  function makeBuilder() {
    const builder = {
      select: () => builder,
      eq: () => builder,
      neq: () => builder,
      insert: () => builder,
      limit: () => builder,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (resolve, reject) => Promise.resolve({ data: null, error: null }).then(resolve, reject),
      update: () => ({
        eq: () => ({ then: (resolve, reject) => Promise.resolve({ error: null }).then(resolve, reject), catch: () => ({}) }),
      }),
    };
    return builder;
  }
  return {
    from: jest.fn((table) => {
      const cfg = responses[table] || {};
      const builder = makeBuilder();
      builder.maybeSingle = () => Promise.resolve(cfg.result || { data: null, error: null });
      builder.then = (resolve, reject) => Promise.resolve(cfg.result || { data: null, error: null }).then(resolve, reject);
      return builder;
    }),
    __setResponse: (table, cfg) => { responses[table] = cfg; },
    __reset: () => { for (const k of Object.keys(responses)) delete responses[k]; },
  };
});

const mockDuffelFn = jest.fn();
jest.mock('../src/services/duffel', () => {
  const fn = (...args) => mockDuffelFn(...args);
  return fn;
});

jest.mock('../src/services/adminConfig', () => ({
  getTicketProfitTiers: jest.fn().mockResolvedValue([{ from: 0, to: null, pct: 10, fixed: 0 }]),
  computeTieredMargin: jest.fn().mockReturnValue(5),
  getAdminConfig: jest.fn().mockResolvedValue(null),
  setAdminConfig: jest.fn().mockResolvedValue(),
}));

jest.mock('../src/services/normalizeOffer', () => ({
  normalizeOffer: (o) => ({ id: o.id, price: o.total_amount, normalized: true }),
}));

const mockLog = jest.fn();
jest.mock('../src/utils/log', () => (...args) => mockLog(...args));

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const env = require('../src/config/env');
const supa = require('../src/clients/supabase');
const { getAdminConfig } = require('../src/services/adminConfig');

env.SEARCH_SESSION_SECRET = 'test-search-session-secret';
env.ADMIN_TOKEN = 'test-admin-token';
env.TURNSTILE_SECRET_KEY = '';

const {
  createSearchSession, verifySearchSession, hashId, SESSION_TTL_SEC,
} = require('../src/middleware/searchGuard');
const { resetPublishedRouteCache } = require('../src/routes/search.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  require('../src/routes/search.routes')(app);
  return app;
}

const app = buildApp();

let ipSeq = 1;
function nextIp() {
  const n = ipSeq++;
  return `203.0.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`;
}
function ss() { return createSearchSession().token; }
function authed(req, token, ip) {
  return req.set('X-Search-Session', token || ss()).set('CF-Connecting-IP', ip || nextIp());
}
function publishPair(from, to) {
  supa.__setResponse('route_pages', {
    result: { data: [{ origin_iata: from, destination_iata: to, status: 'published' }], error: null },
  });
}
function signToken(sid, exp, secret) {
  const payload = `v1.${sid}.${exp}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

beforeEach(() => {
  resetPublishedRouteCache();
  supa.__reset();
  mockDuffelFn.mockReset();
  mockLog.mockClear();
  getAdminConfig.mockReset().mockResolvedValue(null);
  env.TURNSTILE_SECRET_KEY = '';
  mockDuffelFn.mockResolvedValue({ data: { id: 'orq_ok', offers: [{ id: 'off_1', total_amount: '80.00' }] } });
});

describe('Search Session HMAC', () => {
  test('issues a v1.sid.exp.sig token that verifies and lasts 30 minutes', () => {
    const session = createSearchSession();
    expect(session.token).toMatch(/^v1\.[a-f0-9]{32}\.\d+\.[a-f0-9]{64}$/);
    const verified = verifySearchSession(session.token);
    expect(verified).toEqual(expect.objectContaining({ ok: true, sid: session.sid }));
    expect(session.exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(SESSION_TTL_SEC - 5);
    expect(session.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(SESSION_TTL_SEC);
  });

  test('rejects a forged signature', () => {
    const session = createSearchSession();
    const parts = session.token.split('.');
    parts[3] = parts[3].replace(/[0-9a-f]$/, (c) => (c === '0' ? '1' : '0'));
    expect(verifySearchSession(parts.join('.'))).toEqual({ ok: false, reason: 'invalid' });
  });

  test('rejects an expired token', () => {
    const sid = crypto.randomBytes(16).toString('hex');
    const token = signToken(sid, Math.floor(Date.now() / 1000) - 30, env.SEARCH_SESSION_SECRET);
    expect(verifySearchSession(token)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('CASE 1 — bot without Search Session never reaches Duffel', () => {
  test('POST /search without X-Search-Session is 403 and Duffel is not called', async () => {
    const res = await request(app)
      .post('/search')
      .set('CF-Connecting-IP', nextIp())
      .send({ origin: 'BER', destination: 'CDG', departure_date: '2026-08-01' });
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(mockDuffelFn).not.toHaveBeenCalled();
  });

  test('GET /search/airports without a session is 403 and Duffel is not called', async () => {
    const res = await request(app).get('/search/airports?q=berlin').set('CF-Connecting-IP', nextIp());
    expect(res.status).toBe(403);
    expect(mockDuffelFn).not.toHaveBeenCalled();
  });
});

describe('CASE 2 — real guest with Search Session may search without an account', () => {
  test('POST /search/session issues a token without login', async () => {
    const res = await request(app).post('/search/session').set('CF-Connecting-IP', nextIp()).send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.token).toMatch(/^v1\./);
  });

  test('POST /search with that session reaches Duffel and returns offers', async () => {
    const token = (await request(app).post('/search/session').set('CF-Connecting-IP', nextIp()).send({})).body.token;
    const res = await authed(request(app).post('/search'), token)
      .send({ origin: 'BER', destination: 'CDG', departure_date: '2026-11-01' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockDuffelFn).toHaveBeenCalledTimes(1);
  });
});

describe('CASE 3 — admin still works without Search Session', () => {
  test('admin bearer may POST /search without a Search Session', async () => {
    const res = await request(app)
      .post('/search')
      .set('Authorization', 'Bearer test-admin-token')
      .set('CF-Connecting-IP', nextIp())
      .send({ origin: 'DUS', destination: 'PMI', departure_date: '2026-12-01' });
    expect(res.status).toBe(200);
    expect(mockDuffelFn).toHaveBeenCalledTimes(1);
  });
});

describe('CASE 4 — session rate limit stops Duffel before the cap is exceeded', () => {
  test('the 16th POST /search on one session is 429 and Duffel stays at 15', async () => {
    const token = ss();
    const ip = nextIp();
    const statuses = [];
    for (let i = 0; i < 16; i++) {
      const res = await request(app)
        .post('/search')
        .set('X-Search-Session', token)
        .set('CF-Connecting-IP', ip)
        .send({ origin: 'BER', destination: 'CDG', departure_date: `2027-01-${String(i + 1).padStart(2, '0')}` });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 15).every((s) => s === 200)).toBe(true);
    expect(statuses[15]).toBe(429);
    expect(mockDuffelFn).toHaveBeenCalledTimes(15);
  });
});

describe('CASE 5 — Turnstile is verified server-side when configured', () => {
  test('missing turnstile token is 403 when TURNSTILE_SECRET_KEY is set', async () => {
    env.TURNSTILE_SECRET_KEY = 'ts-secret';
    const prevFetch = global.fetch;
    global.fetch = jest.fn();
    try {
      const res = await request(app).post('/search/session').set('CF-Connecting-IP', nextIp()).send({});
      expect(res.status).toBe(403);
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      global.fetch = prevFetch;
      env.TURNSTILE_SECRET_KEY = '';
    }
  });
});

describe('CASE 6 — GET /route-price is fully retired', () => {
  test('returns 410 and Duffel=0 for any route', async () => {
    const res = await request(app).get('/route-price?from=BER&to=CDG').set('CF-Connecting-IP', nextIp());
    expect(res.status).toBe(410);
    expect(res.body).toEqual(expect.objectContaining({ disabled: true, price: null }));
    expect(mockDuffelFn).not.toHaveBeenCalled();
  });
});

describe('CASE 7 — background Duffel warming is off by default', () => {
  test('DUFFEL_BACKGROUND_SEARCH_ENABLED is not true unless env is the string true', () => {
    expect(env.DUFFEL_BACKGROUND_SEARCH_ENABLED).toBe(false);
  });
});
