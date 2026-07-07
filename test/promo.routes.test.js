const mockLookupPromoCode = jest.fn();
jest.mock('../src/services/booking', () => ({
  lookupPromoCode: (...args) => mockLookupPromoCode(...args),
}));

const express = require('express');
const request = require('supertest');

function buildApp() {
  const app = express();
  app.use(express.json());
  require('../src/routes/promo.routes')(app);
  return app;
}

const app = buildApp();

beforeEach(() => {
  mockLookupPromoCode.mockReset();
});

describe('GET /promo/check', () => {
  test('requires a code', async () => {
    const res = await request(app).get('/promo/check');
    expect(res.status).toBe(400);
  });

  test('returns valid:true with the code details for an active promo', async () => {
    mockLookupPromoCode.mockResolvedValue({ valid: true, row: { code: 'SUMMER10', type: 'percent', value: '10' } });
    const res = await request(app).get('/promo/check?code=summer10');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, valid: true, code: 'SUMMER10', type: 'percent', value: 10 });
    expect(mockLookupPromoCode).toHaveBeenCalledWith('summer10');
  });

  test('returns valid:false with the reason for an inactive promo', async () => {
    mockLookupPromoCode.mockResolvedValue({ valid: false, reason: 'inactive' });
    const res = await request(app).get('/promo/check?code=OLDCODE');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, valid: false, reason: 'inactive' });
  });

  test('returns valid:false with reason expired', async () => {
    mockLookupPromoCode.mockResolvedValue({ valid: false, reason: 'expired' });
    const res = await request(app).get('/promo/check?code=EXPIRED1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, valid: false, reason: 'expired' });
  });

  test('returns valid:false with reason max_uses_reached', async () => {
    mockLookupPromoCode.mockResolvedValue({ valid: false, reason: 'max_uses_reached' });
    const res = await request(app).get('/promo/check?code=POPULAR1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, valid: false, reason: 'max_uses_reached' });
  });

  test('defaults to reason "invalid" for a code that does not exist', async () => {
    mockLookupPromoCode.mockResolvedValue(null);
    const res = await request(app).get('/promo/check?code=NOPE');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, valid: false, reason: 'invalid' });
  });

  test('surfaces an error as a 500', async () => {
    mockLookupPromoCode.mockRejectedValue(new Error('db unavailable'));
    const res = await request(app).get('/promo/check?code=ANY');
    expect(res.status).toBe(500);
  });
});
