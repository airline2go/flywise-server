/**
 * Tests — GET /offer/:id input validation
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

vi.mock('pino', () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, fatal: noop, debug: noop };
  return { default: () => logger };
});

vi.mock('../services/duffelClient.js', () => ({
  duffelRequest: vi.fn().mockResolvedValue({
    data: {
      id: 'off_123',
      slices: [],
      passengers: [],
      total_amount: '199.00',
      total_currency: 'EUR',
      available_services: [],
    },
  }),
}));

process.env.DUFFEL_TOKEN = 'test_token_offers';
process.env.NODE_ENV     = 'test';

const app = (await import('../server.js')).default;

describe('GET /offer/:id — validation', () => {
  it('rejects an ID with invalid characters', async () => {
    const res = await request(app).get('/offer/../../etc/passwd');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it('rejects an ID that is too long (>200 chars)', async () => {
    const longId = 'a'.repeat(201);
    const res = await request(app).get(`/offer/${longId}`);
    expect(res.status).toBe(400);
  });

  it('accepts a valid alphanumeric ID', async () => {
    const res = await request(app).get('/offer/off_abc123XYZ');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns offer + services on success', async () => {
    const res = await request(app).get('/offer/off_abc123');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('offer');
    expect(Array.isArray(res.body.services)).toBe(true);
    expect(res.body.reqId).toBeDefined();
  });

  it('accepts IDs with hyphens and underscores', async () => {
    const res = await request(app).get('/offer/off_abc-123_XYZ');
    expect(res.status).toBe(200);
  });
});
