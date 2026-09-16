jest.mock('../src/middleware/rateLimit', () => () => (req, res, next) => next());
jest.mock('../src/config/env', () => ({
  ALLOWED_ORIGINS: ['https://airpiv.com', 'https://www.airpiv.com'],
}));

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

  test('keeps webhook and health paths reachable for their own verification', async () => {
    const app = express();
    apiAccessShield(app);
    app.post('/webhooks/stripe', (req, res) => res.sendStatus(200));
    app.get('/health', (req, res) => res.sendStatus(200));
    expect((await request(app).post('/webhooks/stripe')).status).toBe(200);
    expect((await request(app).get('/health')).status).toBe(200);
  });
});
