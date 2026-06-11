/**
 * Tests — POST /search input validation
 * Duffel API calls are mocked so no real HTTP requests are made.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('pino', () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, fatal: noop, debug: noop };
  return { default: () => logger };
});

// Mock duffelRequest to avoid real API calls
vi.mock('../services/duffelClient.js', () => ({
  duffelRequest: vi.fn().mockResolvedValue({
    data: { id: 'offreq_123', offers: [] },
  }),
}));

process.env.DUFFEL_TOKEN = 'test_token_search';
process.env.NODE_ENV     = 'test';

const app = (await import('../server.js')).default;

// ── Valid base payload ────────────────────────────────────
const valid = {
  origin:         'BER',
  destination:    'LHR',
  departure_date: '2026-08-15',
};

describe('POST /search — validation', () => {

  describe('required fields', () => {
    it('rejects missing origin', async () => {
      const res = await request(app).post('/search').send({ ...valid, origin: undefined });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/origin/i);
    });

    it('rejects missing destination', async () => {
      const res = await request(app).post('/search').send({ ...valid, destination: undefined });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/destination/i);
    });

    it('rejects missing departure_date', async () => {
      const res = await request(app).post('/search').send({ ...valid, departure_date: undefined });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/departure_date/i);
    });
  });

  describe('IATA codes', () => {
    it('rejects 2-letter IATA', async () => {
      const res = await request(app).post('/search').send({ ...valid, origin: 'BE' });
      expect(res.status).toBe(400);
    });

    it('rejects 4-letter IATA', async () => {
      const res = await request(app).post('/search').send({ ...valid, origin: 'BERR' });
      expect(res.status).toBe(400);
    });

    it('accepts lowercase IATA and uppercases it', async () => {
      const res = await request(app).post('/search').send({ ...valid, origin: 'ber' });
      // Either 200 (duffel mock returns ok) or a Duffel error — not a 400 validation error
      expect(res.status).not.toBe(400);
    });
  });

  describe('date validation', () => {
    const badDates = [
      ['wrong format',    '15.08.2026'],
      ['impossible month','2026-99-99'],
      ['Feb 31',         '2026-02-31'],
      ['month 13',       '2026-13-01'],
      ['non-numeric',    'abc-de-fg'],
    ];

    for (const [label, date] of badDates) {
      it(`rejects ${label} (${date})`, async () => {
        const res = await request(app).post('/search').send({ ...valid, departure_date: date });
        expect(res.status).toBe(400);
        expect(res.body.ok).toBe(false);
      });
    }

    it('accepts valid leap-year date 2024-02-29', async () => {
      const res = await request(app).post('/search').send({ ...valid, departure_date: '2024-02-29' });
      expect(res.status).not.toBe(400);
    });

    it('rejects 2026-02-29 (not a leap year)', async () => {
      const res = await request(app).post('/search').send({ ...valid, departure_date: '2026-02-29' });
      expect(res.status).toBe(400);
    });

    it('validates return_date when provided', async () => {
      const res = await request(app).post('/search').send({
        ...valid, return_date: '2026-99-99',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/return_date/i);
    });
  });

  describe('cabin class', () => {
    it('rejects invalid cabin class', async () => {
      const res = await request(app).post('/search').send({ ...valid, cabin_class: 'vip' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/cabin_class/i);
    });

    const validCabins = ['economy', 'premium_economy', 'business', 'first'];
    for (const cabin of validCabins) {
      it(`accepts cabin_class "${cabin}"`, async () => {
        const res = await request(app).post('/search').send({ ...valid, cabin_class: cabin });
        expect(res.status).not.toBe(400);
      });
    }
  });

  describe('same origin/destination', () => {
    it('rejects when origin equals destination', async () => {
      const res = await request(app).post('/search').send({ ...valid, destination: 'BER' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/different/i);
    });

    it('rejects case-insensitively', async () => {
      const res = await request(app).post('/search').send({ ...valid, origin: 'lhr', destination: 'LHR' });
      expect(res.status).toBe(400);
    });
  });

  describe('successful request', () => {
    it('returns 200 with offers array on valid input', async () => {
      const res = await request(app).post('/search').send(valid);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(Array.isArray(res.body.offers)).toBe(true);
      expect(res.body).toHaveProperty('total');
      expect(res.body.reqId).toBeDefined();
    });
  });
});
