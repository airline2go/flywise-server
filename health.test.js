/**
 * Tests — GET / and GET /health
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

vi.mock('pino', () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, fatal: noop, debug: noop };
  return { default: () => logger };
});

process.env.DUFFEL_TOKEN = 'test_token_health';
process.env.NODE_ENV     = 'test';

const app = (await import('../server.js')).default;

// ── GET / ─────────────────────────────────────────────────

describe('GET /', () => {
  it('returns 200 with service info', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe('FlyWise Duffel Proxy');
    expect(res.body.version).toBe('3.4');
    expect(res.body.tokenConfigured).toBe(true);
  });

  it('includes X-Request-Id header in response', async () => {
    const res = await request(app).get('/');
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('echoes an incoming X-Request-Id header', async () => {
    const id  = 'trace-abc-123';
    const res = await request(app).get('/').set('x-request-id', id);
    expect(res.headers['x-request-id']).toBe(id);
    expect(res.body.reqId).toBe(id);
  });
});

// ── GET /health ───────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 when config is valid', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns an ISO timestamp', async () => {
    const res = await request(app).get('/health');
    expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('includes a checks object with all expected keys', async () => {
    const res = await request(app).get('/health');
    const { checks } = res.body;
    expect(checks).toHaveProperty('token',        true);
    expect(checks).toHaveProperty('corsOrigins',  true);
    expect(checks).toHaveProperty('fetchTimeout', true);
    expect(checks).toHaveProperty('port',         true);
  });

  it('includes reqId in body', async () => {
    const res = await request(app).get('/health');
    expect(res.body.reqId).toBeDefined();
  });
});
