jest.mock('../src/middleware/rateLimit', () => (bucket, max, windowMs) => {
  global.__airpivRateLimitCalls = global.__airpivRateLimitCalls || [];
  global.__airpivRateLimitCalls.push({ bucket, max, windowMs });
  return (req, res, next) => next();
});
const mockEnv = {
  ALLOWED_ORIGINS: ['https://airpiv.com', 'https://www.airpiv.com'],
  EDGE_SHARED_SECRET: '',
};
jest.mock('../src/config/env', () => mockEnv);

const express = require('express');
const request = require('supertest');
const apiAccessShield = require('../src/middleware/apiAccessShield');

function buildApp() {
  const app = express();
  apiAccessShield(app);
  app.get('/protected', (req, res) => res.json({ ok: true }));
  return app;
}

describe('apiAccessShield', () => {
  beforeEach(() => {
    global.__airpivRateLimitCalls = [];
  });

  afterEach(() => {
    mockEnv.EDGE_SHARED_SECRET = '';
  });

  test('rejects missing user-agent', async () => {
    const res = await request(buildApp()).get('/protected').set('Origin', 'https://airpiv.com');
    expect(res.status).toBe(403);
  });

  test('rejects automation clients even with allowed origin', async () => {
    const res = await request(buildApp()).get('/protected')
      .set('User-Agent', 'python-requests/2.32')
      .set('Origin', 'https://airpiv.com');
    expect(res.status).toBe(403);
  });

  test('rejects direct non-browser access without auth', async () => {
    const res = await request(buildApp()).get('/protected').set('User-Agent', 'Mozilla/5.0');
    expect(res.status).toBe(403);
  });

  test('allows Airpiv browser origin', async () => {
    const res = await request(buildApp()).get('/protected')
      .set('User-Agent', 'Mozilla/5.0')
      .set('Origin', 'https://airpiv.com');
    expect(res.status).toBe(200);
  });

  test('allows authenticated service/admin requests without browser origin', async () => {
    const res = await request(buildApp()).get('/protected')
      .set('User-Agent', 'Mozilla/5.0')
      .set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
  });

  test('configures a separate higher rate budget for trusted server GETs', () => {
    buildApp();
    expect(global.__airpivRateLimitCalls).toEqual(expect.arrayContaining([
      { bucket: 'api-edge-server-burst', max: 240, windowMs: 10000 },
      { bucket: 'api-edge-server-sustained', max: 2400, windowMs: 60000 },
    ]));
  });

  test.each(['next.js/16.2.10', 'node/22.0.0', 'undici'])('allows trusted server GETs with supported UA: %s', async (userAgent) => {
    const res = await request(buildApp()).get('/protected')
      .set('User-Agent', userAgent)
      .set('Accept', 'application/json');
    expect(res.status).toBe(200);
  });

  test('does not allow the trusted server UA on a non-GET request', async () => {
    const app = express();
    apiAccessShield(app);
    app.post('/protected', (req, res) => res.json({ ok: true }));
    const res = await request(app).post('/protected').set('User-Agent', 'node/22.0.0');
    expect(res.status).toBe(403);
  });

  test('blocks protected traffic when the configured edge secret is missing', async () => {
    mockEnv.EDGE_SHARED_SECRET = 'test-edge-secret';
    const res = await request(buildApp()).get('/protected')
      .set('User-Agent', 'Mozilla/5.0')
      .set('Origin', 'https://airpiv.com');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('API origin access is restricted.');
  });

  test('allows protected traffic with the exact configured edge secret', async () => {
    mockEnv.EDGE_SHARED_SECRET = 'test-edge-secret';
    const res = await request(buildApp()).get('/protected')
      .set('User-Agent', 'Mozilla/5.0')
      .set('Origin', 'https://airpiv.com')
      .set('X-Airpiv-Edge-Secret', 'test-edge-secret');
    expect(res.status).toBe(200);
  });

  test('does not let a wrong edge secret through even with valid browser provenance', async () => {
    mockEnv.EDGE_SHARED_SECRET = 'test-edge-secret';
    const res = await request(buildApp()).get('/protected')
      .set('User-Agent', 'Mozilla/5.0')
      .set('Origin', 'https://airpiv.com')
      .set('X-Airpiv-Edge-Secret', 'wrong-secret');
    expect(res.status).toBe(403);
  });

  test('keeps webhook and health paths reachable for their own verification', async () => {
    mockEnv.EDGE_SHARED_SECRET = 'test-edge-secret';
    const app = express();
    apiAccessShield(app);
    app.post('/webhooks/stripe', (req, res) => res.sendStatus(200));
    app.get('/health', (req, res) => res.sendStatus(200));
    expect((await request(app).post('/webhooks/stripe')).status).toBe(200);
    expect((await request(app).get('/health')).status).toBe(200);
  });
});
