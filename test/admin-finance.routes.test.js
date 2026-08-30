process.env.ADMIN_TOKEN = 'test-admin-token';

// Flexible chainable Supabase mock: any builder method returns the builder;
// terminal via then()/maybeSingle() resolving per-table data.
jest.mock('../src/clients/supabase', () => {
  const data = {
    finance_config: [
      { key: 'vat_regime', value: 'REGELBESTEUERUNG', review_status: 'APPROVED' },
      { key: 'airpiv_business_role', value: 'REVIEW_REQUIRED', review_status: 'REVIEW_REQUIRED' },
    ],
    financial_events: [
      { event_type: 'stripe_fee', original_amount_minor: 350, accounting_amount_eur_minor: 350, review_status: 'REVIEW_REQUIRED', original_currency: 'EUR' },
      { event_type: 'duffel_invoice_line', original_amount_minor: 10000, accounting_amount_eur_minor: 10000, review_status: 'REVIEW_REQUIRED', original_currency: 'EUR' },
    ],
    stripe_transactions: [{ fee_minor: 350 }],
    duffel_invoice_lines: [{ gross_minor: 10000, match_status: 'UNMATCHED' }],
    refunds: [{ original_amount_minor: 5000, tax_adjustment_status: 'REVIEW_REQUIRED' }],
    chargebacks: [{ amount_minor: 2000, tax_treatment_status: 'REVIEW_REQUIRED' }],
    tax_exceptions: [{ status: 'OPEN' }],
    reconciliation_exceptions: [{ status: 'OPEN', severity: 'REVIEW' }],
    reconciliation_matches: [{ status: 'MATCHED' }],
  };
  function build(table) {
    const chain = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (resolve) => Promise.resolve({ data: data[table] || [], error: null }).then(resolve);
        if (prop === 'maybeSingle') return () => Promise.resolve({ data: (data[table] || [])[0] || null, error: null });
        return () => chain;
      },
    });
    return chain;
  }
  return { from: (t) => build(t) };
});

const express = require('express');
const request = require('supertest');

function makeApp() {
  const app = express();
  app.use(express.json());
  require('../src/routes/admin-finance.routes')(app);
  return app;
}
const AUTH = { Authorization: 'Bearer test-admin-token' };

describe('admin-finance routes', () => {
  const app = makeApp();

  test('GET /admin/finance/dashboard reports source totals + REVIEW_REQUIRED vat', async () => {
    const res = await request(app).get('/admin/finance/dashboard').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.vat.output_vat).toBe('REVIEW_REQUIRED');
    expect(res.body.vat.input_vat).toBe('REVIEW_REQUIRED');
    expect(res.body.totals_minor.stripe_fees).toBe(350);
    expect(res.body.config.vat_regime.value).toBe('REGELBESTEUERUNG');
    expect(res.body.status_counts.REVIEW_REQUIRED).toBe(2);
  });

  test('GET /admin/finance/transactions returns events', async () => {
    const res = await request(app).get('/admin/finance/transactions').set(AUTH);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.transactions)).toBe(true);
  });

  test('GET /admin/finance/accountant/summary requires year+month', async () => {
    const bad = await request(app).get('/admin/finance/accountant/summary').set(AUTH);
    expect(bad.status).toBe(400);
    const ok = await request(app).get('/admin/finance/accountant/summary?year=2026&month=8').set(AUTH);
    expect(ok.status).toBe(200);
    expect(ok.body.vat.output_vat).toBe('REVIEW_REQUIRED');
    expect(ok.body.note).toMatch(/REVIEW_REQUIRED/);
  });

  test('unauthenticated request is rejected', async () => {
    const res = await request(app).get('/admin/finance/dashboard');
    expect(res.status).toBe(401);
  });
});
