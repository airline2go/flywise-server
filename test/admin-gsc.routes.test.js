// [GSC-OAUTH] Tests for the Google Search Console connection endpoints. Run
// offline: with no GOOGLE_OAUTH_* env the endpoints report not-configured /
// not-connected deterministically, and the callback redirects on a bad state —
// so we assert auth, config gating, and CSRF handling without any network.
process.env.ADMIN_TOKEN = 'test-admin-token';

jest.mock('../src/clients/supabase', () => {
  const store = {};
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then: (r) => Promise.resolve({ data: null, error: null }).then(r),
  };
  return { from: jest.fn(() => builder), auth: { getUser: jest.fn() }, __store: store };
});

const express = require('express');
const request = require('supertest');
const env = require('../src/config/env');

function buildApp() {
  const app = express();
  app.use(express.json());
  require('../src/routes/admin-gsc.routes')(app);
  return app;
}
const OWNER_AUTH = { Authorization: 'Bearer test-admin-token' };

describe('GSC endpoints — auth + config gating (not configured)', () => {
  beforeEach(() => {
    delete env.GOOGLE_OAUTH_CLIENT_ID;
    delete env.GOOGLE_OAUTH_CLIENT_SECRET;
    delete env.GOOGLE_OAUTH_REDIRECT_URI;
  });

  test('status requires admin', async () => {
    const res = await request(buildApp()).get('/admin/seo/gsc/status');
    expect(res.status).toBe(401);
  });

  test('status reports configured:false when the OAuth env is unset', async () => {
    const res = await request(buildApp()).get('/admin/seo/gsc/status').set(OWNER_AUTH);
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.connected).toBe(false);
  });

  test('connect returns 503 when not configured', async () => {
    const res = await request(buildApp()).get('/admin/seo/gsc/connect').set(OWNER_AUTH);
    expect(res.status).toBe(503);
  });

  test('data reports not-connected (no rows) when not configured', async () => {
    const res = await request(buildApp()).get('/admin/seo/gsc/data').set(OWNER_AUTH);
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
    expect(res.body.rows).toEqual([]);
  });
});

describe('GSC callback — CSRF/state handling', () => {
  test('redirects to the dashboard with gsc=error on a missing state/code', async () => {
    const res = await request(buildApp()).get('/admin/seo/gsc/callback');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/admin\/seo-opportunities\?gsc=error$/);
  });
});

describe('GSC status — configured but not yet connected', () => {
  test('reports configured:true, connected:false when a token is not stored', async () => {
    env.GOOGLE_OAUTH_CLIENT_ID = 'cid';
    env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret';
    env.GOOGLE_OAUTH_REDIRECT_URI = 'https://api.airpiv.com/admin/seo/gsc/callback';
    try {
      const res = await request(buildApp()).get('/admin/seo/gsc/status').set(OWNER_AUTH);
      expect(res.status).toBe(200);
      expect(res.body.configured).toBe(true);
      expect(res.body.connected).toBe(false);
    } finally {
      delete env.GOOGLE_OAUTH_CLIENT_ID;
      delete env.GOOGLE_OAUTH_CLIENT_SECRET;
      delete env.GOOGLE_OAUTH_REDIRECT_URI;
    }
  });
});
