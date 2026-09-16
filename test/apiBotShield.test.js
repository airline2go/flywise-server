const express = require('express');
const request = require('supertest');
const apiBotShield = require('../src/middleware/apiBotShield');

describe('apiBotShield', () => {
  function makeApp() {
    const app = express();
    apiBotShield(app);
    app.get('/public', (req, res) => res.json({ ok: true }));
    return app;
  }

  test('blocks known crawler user agents before route handling', async () => {
    const res = await request(makeApp())
      .get('/public')
      .set('User-Agent', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');

    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
  });

  test('allows normal browser user agents', async () => {
    const res = await request(makeApp())
      .get('/public')
      .set('User-Agent', 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('publishes a deny-all robots policy', async () => {
    const res = await request(makeApp()).get('/robots.txt');

    expect(res.status).toBe(200);
    expect(res.text).toContain('User-agent: *');
    expect(res.text).toContain('Disallow: /');
  });
});
