/**
 * Tests — 404 handler, request ID middleware, CORS
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

vi.mock('pino', () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, fatal: noop, debug: noop };
  return { default: () => logger };
});

process.env.DUFFEL_TOKEN = 'test_token_404';
process.env.NODE_ENV     = 'test';

const app = (await import('../server.js')).default;

describe('404 handler', () => {
  it('returns 404 for unknown GET route', async () => {
    const res = await request(app).get('/unknown-route');
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns 404 for unknown POST route', async () => {
    const res = await request(app).post('/does-not-exist').send({});
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });

  it('includes reqId in 404 response', async () => {
    const res = await request(app).get('/no-such-route');
    expect(res.body.reqId).toBeDefined();
  });

  it('includes the method and path in the error message', async () => {
    const res = await request(app).get('/some/deep/path');
    expect(res.body.error).toContain('GET');
  });
});

describe('Request ID middleware', () => {
  it('always returns X-Request-Id header', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['x-request-id'].length).toBeGreaterThan(0);
  });

  it('generates different IDs for each request', async () => {
    const [r1, r2] = await Promise.all([
      request(app).get('/health'),
      request(app).get('/health'),
    ]);
    expect(r1.headers['x-request-id']).not.toBe(r2.headers['x-request-id']);
  });
});

describe('CORS headers', () => {
  it('returns CORS headers on OPTIONS preflight', async () => {
    const res = await request(app)
      .options('/search')
      .set('Origin', 'https://example.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });

  it('exposes X-Request-Id in CORS headers', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['access-control-expose-headers']).toContain('X-Request-Id');
  });
});
