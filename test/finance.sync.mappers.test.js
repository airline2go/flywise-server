const { mapBalanceTxn, mapPayout } = require('../src/services/finance/stripeSync');
const { mapInvoice } = require('../src/services/finance/duffelSync');

describe('finance/stripeSync mappers', () => {
  test('balance transaction maps minor units + fee + payout link, no VAT invented', () => {
    const bt = {
      id: 'txn_1', type: 'charge', source: 'ch_1', amount: 11500, fee: 350, net: 11150,
      currency: 'eur', payout: 'po_1', created: 1700000000,
      fee_details: [{ type: 'stripe_fee', amount: 350, currency: 'eur', description: 'Stripe processing fees' }],
    };
    const row = mapBalanceTxn(bt);
    expect(row.stripe_id).toBe('txn_1');
    expect(row.gross_minor).toBe(11500);
    expect(row.fee_minor).toBe(350);
    expect(row.currency).toBe('EUR');
    expect(row.payout_id).toBe('po_1');
    // A fee is a fee — nothing in the mapping treats it as tax/VAT.
    expect(row).not.toHaveProperty('vat_minor');
  });

  test('payout maps id/amount/status', () => {
    const row = mapPayout({ id: 'po_1', amount: 500000, currency: 'eur', status: 'paid', arrival_date: 1700000000 });
    expect(row.stripe_id).toBe('po_1');
    expect(row.amount_minor).toBe(500000);
    expect(row.status).toBe('paid');
  });
});

describe('finance/duffelSync mapper', () => {
  test('official invoice maps to minor units + idempotency key', () => {
    const inv = {
      id: 'inv_1', invoice_number: 'D-2026-1', currency: 'EUR',
      subtotal: 100.00, tax_amount: 0, total_amount: 100.00, supplier_name: 'Duffel',
    };
    const row = mapInvoice(inv);
    expect(row.subtotal_minor).toBe(10000);
    expect(row.total_minor).toBe(10000);
    expect(row.idempotency_key).toBe('duffel_invoice:inv_1');
    expect(row.currency).toBe('EUR');
  });
});
