// [F6 · PAYMENT-LEDGER] The payments row must record what the CUSTOMER paid
// (Stripe), with the Duffel supplier cost and margin in their own columns —
// NOT the supplier net masquerading as the customer amount.

const mockInserts = { payments: [], bookings: [] };

jest.mock('../src/clients/supabase', () => ({
  from: (table) => ({
    insert: (row) => { (mockInserts[table] = mockInserts[table] || []).push(row); return Promise.resolve({ error: null }); },
    upsert: (row) => { (mockInserts[table] = mockInserts[table] || []).push(row); return Promise.resolve({ error: null }); },
    select: function () { return this; },
    eq: function () { return this; },
    update: function () { return this; },
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
  }),
  rpc: () => Promise.resolve({ data: true, error: null }),
}));
jest.mock('../src/utils/log', () => jest.fn());

const mockDuffelFn = jest.fn();
jest.mock('../src/services/duffel', () => {
  const fn = (...a) => mockDuffelFn(...a);
  fn.getDuffelCircuitStatus = () => ({ state: 'closed' });
  return fn;
});
jest.mock('../src/clients/stripe', () => ({ refunds: { create: jest.fn() } }));
jest.mock('../src/services/adminConfig', () => ({
  computeTieredMargin: () => 13,          // €13 margin per passenger
  getTicketProfitTiers: async () => [],
  getAncillaryProfitTiers: async () => [],
}));
jest.mock('../src/services/loyalty', () => ({
  computeLoyaltyDiscount: async () => ({ account: null, discount: 0 }),
  applyLoyaltyForBooking: async () => 0,
}));
jest.mock('../src/services/referrals', () => ({ attachBookingIfReferred: async () => {} }));
jest.mock('../src/services/email', () => ({
  sendBookingConfirmationEmail: async () => {},
  buildOrderSummaryForEmail: () => ({}),
}));

const mockGetPending = jest.fn();
jest.mock('../src/services/pendingBookings', () => ({
  getPendingBooking: (...a) => mockGetPending(...a),
  markPendingBooked: async () => {},
  setBookingStatus: () => {},
}));

const { bookFromSession } = require('../src/services/booking');

function mockHappyDuffel() {
  mockDuffelFn.mockImplementation((method, path) => {
    if (path.includes('/air/seat_maps')) return Promise.resolve({ data: [] });
    if (method === 'GET' && path.includes('return_available_services=true')) {
      return Promise.resolve({ data: { total_amount: '100', total_currency: 'EUR', passengers: [{ type: 'adult' }], available_services: [] } });
    }
    if (method === 'GET' && /\/air\/offers\/off_1$/.test(path)) {
      return Promise.resolve({ data: { passengers: [{ id: 'pax_1', type: 'adult' }] } });
    }
    if (method === 'POST' && path === '/air/orders') {
      return Promise.resolve({ data: { id: 'ord_happy', booking_reference: 'REF', total_amount: '100', total_currency: 'EUR' } });
    }
    if (method === 'GET' && path === '/air/orders/ord_happy') {
      return Promise.resolve({ data: { id: 'ord_happy', slices: [] } });
    }
    return Promise.reject(new Error('unexpected duffel call: ' + method + ' ' + path));
  });
}

beforeEach(() => {
  mockInserts.payments = []; mockInserts.bookings = [];
  mockDuffelFn.mockReset();
  mockGetPending.mockReset();
});

test('payments ledger records customer_paid as amount, with supplier cost and margin separate', async () => {
  mockGetPending.mockResolvedValue({
    payload: {
      offer_id: 'off_1',
      passengers: [{ type: 'adult', given_name: 'A', family_name: 'B' }],
      services: [],
      customer_amount: 113,   // customer paid €113 (net €100 + €13 margin)
      duffel_amount: '100',
      currency: 'EUR',
    },
    duffel_order_id: '',
  });
  mockHappyDuffel();

  await bookFromSession('cs_ledger', { payment_intent: 'pi_ledger' });

  expect(mockInserts.payments).toHaveLength(1);
  const p = mockInserts.payments[0];
  // The whole point of F6: amount is the CUSTOMER charge, not the €100 supplier net.
  expect(p.amount).toBe(113);
  expect(p.supplier_amount).toBe(100);
  expect(p.margin_amount).toBe(13);
  expect(p.currency).toBe('EUR');
  expect(p.stripe_payment_id).toBe('pi_ledger');

  // And the bookings row still carries the authoritative customer_paid.
  expect(mockInserts.bookings).toHaveLength(1);
  expect(mockInserts.bookings[0].customer_paid).toBe(113);
  expect(mockInserts.bookings[0].duffel_amount).toBe(100);
});
