process.env.DUFFEL_TOKEN = 'test_dummy_token';
delete process.env.STRIPE_SECRET_KEY;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_KEY;
delete process.env.ADMIN_TOKEN;

const request = require('supertest');
const app = require('../server');

describe('health routes', () => {
  test('GET / returns service info', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, service: 'Airpiv Server', tokenConfigured: true, stripeConfigured: false });
  });

  test('GET /status returns service info', async () => {
    const res = await request(app).get('/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, service: 'Airpiv Server' });
  });

  test('GET /health reports duffel ok, others not configured', async () => {
    const res = await request(app).get('/health');
    expect(res.body.checks.duffel.ok).toBe(true);
    expect(res.body.checks.stripe.ok).toBe(false);
    expect(res.body.checks.supabase.ok).toBe(false);
  });
});

describe('promo routes', () => {
  test('GET /promo/check without code returns 400', async () => {
    const res = await request(app).get('/promo/check');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'code erforderlich' });
  });
});

describe('cancel routes validation', () => {
  test('POST /cancel without order_id returns 400', async () => {
    const res = await request(app).post('/cancel').send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'order_id مطلوب' });
  });

  test('POST /cancel-quote without order_id returns 400', async () => {
    const res = await request(app).post('/cancel-quote').send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'order_id مطلوب' });
  });

  test('POST /cancel-confirm without cancellation_id returns 400', async () => {
    const res = await request(app).post('/cancel-confirm').send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'cancellation_id مطلوب' });
  });
});

describe('booking routes without stripe configured', () => {
  test('POST /create-checkout-session returns 500 stripe not configured', async () => {
    const res = await request(app).post('/create-checkout-session').send({});
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: 'Stripe ist nicht konfiguriert' });
  });

  test('POST /confirm-payment returns 500 stripe not configured', async () => {
    const res = await request(app).post('/confirm-payment').send({ session_id: 'sess_1' });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: 'Stripe ist nicht konfiguriert' });
  });

  test('GET /booking-status/:sessionId with unknown session returns status unknown', async () => {
    const res = await request(app).get('/booking-status/does-not-exist');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: 'unknown' });
  });
});

describe('admin auth', () => {
  test('admin-only route returns 503 when ADMIN_TOKEN is not configured', async () => {
    const res = await request(app).get('/debug/raw?origin=BER&destination=CDG&departure_date=2026-06-01');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, error: 'ADMIN_TOKEN nicht konfiguriert' });
  });
});
