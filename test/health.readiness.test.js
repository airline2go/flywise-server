// [F11 · READINESS] GET /readiness gates only on the database (the critical
// serving dependency), not on Duffel/Stripe/Redis.

let mockDbError = null;
jest.mock('../src/clients/supabase', () => ({
  from: () => ({
    select: function () { return this; },
    limit: () => Promise.resolve({ data: [], error: mockDbError }),
  }),
}));
jest.mock('../src/clients/redis', () => null);
jest.mock('../src/utils/log', () => jest.fn());
jest.mock('../src/services/duffel', () => {
  const fn = () => Promise.resolve({});
  fn.getDuffelCircuitStatus = () => ({ state: 'closed', consecutiveFailures: 0 });
  return fn;
});
jest.mock('../src/services/adminConfig', () => ({
  getAdminConfig: jest.fn().mockResolvedValue({ enabled: false, message: '' }),
  setAdminConfig: jest.fn().mockResolvedValue(true),
}));

const express = require('express');
const request = require('supertest');

function buildApp() {
  const app = express();
  require('../src/routes/health.routes')(app);
  return app;
}

beforeEach(() => { mockDbError = null; });

test('returns 200 ready:true when the database is reachable', async () => {
  const res = await request(buildApp()).get('/readiness');
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ ok: true, ready: true });
});

test('returns 503 ready:false when the database query errors', async () => {
  mockDbError = { message: 'connection refused' };
  const res = await request(buildApp()).get('/readiness');
  expect(res.status).toBe(503);
  expect(res.body).toMatchObject({ ok: false, ready: false });
});
