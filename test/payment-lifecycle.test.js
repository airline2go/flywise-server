// ═══════════════════════════════════════════════════════════════
// test/payment-lifecycle.test.js
// [PAYMENT-LIFECYCLE] The mandated test matrix (brief §39) for the
// AUTHORIZE → BOOK → CAPTURE / CANCEL-ON-FAILURE flow. Proves the two
// headline flows and the dangerous edge cases:
//   SUCCESS:  authorize → Duffel booking → capture → confirmed
//   FAILURE:  authorize → Duffel failure → CANCEL authorization → NO refund
// plus capture-failure manual review, idempotency, and the reconciliation
// mismatch classifier. Pure service-level: Supabase is null, Stripe/Duffel
// are mocked, so it is fully deterministic and offline.
// ═══════════════════════════════════════════════════════════════

jest.mock('../src/clients/supabase', () => null);
jest.mock('../src/utils/log', () => jest.fn());
jest.mock('../src/clients/sentry', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));

const mockDuffelFn = jest.fn();
jest.mock('../src/services/duffel', () => {
  const fn = (...args) => mockDuffelFn(...args);
  fn.getDuffelCircuitStatus = () => ({ state: 'closed', consecutiveFailures: 0 });
  return fn;
});

// Stripe mock with a full PaymentIntents surface (retrieve/capture/cancel)
// and refunds — so we can assert exactly which one is (or isn't) called.
const mockPI = {
  retrieve: jest.fn(),
  capture: jest.fn(),
  cancel: jest.fn(),
};
const mockRefundsCreate = jest.fn().mockResolvedValue({});
jest.mock('../src/clients/stripe', () => ({
  paymentIntents: {
    retrieve: (...a) => mockPI.retrieve(...a),
    capture: (...a) => mockPI.capture(...a),
    cancel: (...a) => mockPI.cancel(...a),
  },
  refunds: { create: (...a) => mockRefundsCreate(...a) },
}));

const { bookFromSession } = require('../src/services/booking');
const { rememberBooking } = require('../src/services/pendingBookings');
const payments = require('../src/services/payments');

// Session whose PaymentIntent is a manual authorization (requires_capture).
function authorizedSession(id, piId = 'pi_auth') {
  return { id, payment_intent: piId, payment_status: 'unpaid', status: 'complete', customer_details: { email: null } };
}

// Duffel that books successfully.
function happyDuffel({ orderId = 'ord_1', bookingRef = 'REF1', offerTotal = '100' } = {}) {
  mockDuffelFn.mockImplementation((method, path) => {
    if (path.includes('/air/seat_maps')) return Promise.resolve({ data: [] });
    if (method === 'GET' && path.includes('return_available_services=true')) {
      return Promise.resolve({ data: { total_amount: offerTotal, total_currency: 'EUR', passengers: [{ type: 'adult' }], available_services: [] } });
    }
    if (method === 'GET' && /\/air\/offers\/off_1$/.test(path)) {
      return Promise.resolve({ data: { passengers: [{ id: 'pax_1', type: 'adult' }] } });
    }
    if (method === 'POST' && path === '/air/orders') {
      return Promise.resolve({ data: { id: orderId, booking_reference: bookingRef, total_amount: offerTotal, total_currency: 'EUR' } });
    }
    if (method === 'GET' && path === `/air/orders/${orderId}`) {
      return Promise.resolve({ data: { id: orderId, slices: [] } });
    }
    return Promise.reject(new Error('unexpected duffel call: ' + method + ' ' + path));
  });
}

// Duffel whose order creation fails (offer expired / API error).
function failingDuffel(errMessage = 'offer_no_longer_available') {
  mockDuffelFn.mockImplementation((method, path) => {
    if (path.includes('/air/seat_maps')) return Promise.resolve({ data: [] });
    if (method === 'GET' && path.includes('return_available_services=true')) {
      return Promise.resolve({ data: { total_amount: '100', total_currency: 'EUR', passengers: [{ type: 'adult' }], available_services: [] } });
    }
    if (method === 'GET' && /\/air\/offers\/off_1$/.test(path)) {
      return Promise.resolve({ data: { passengers: [{ id: 'pax_1', type: 'adult' }] } });
    }
    if (method === 'POST' && path === '/air/orders') {
      const e = new Error(errMessage); e.status = 422; e.code = 'ORDER_CREATE_FAILED'; return Promise.reject(e);
    }
    return Promise.reject(new Error('unexpected duffel call: ' + method + ' ' + path));
  });
}

beforeEach(() => {
  mockDuffelFn.mockReset();
  mockPI.retrieve.mockReset();
  mockPI.capture.mockReset();
  mockPI.cancel.mockReset();
  mockRefundsCreate.mockClear();
  mockRefundsCreate.mockResolvedValue({});
});

// ─── TEST 1 — NORMAL SUCCESS ────────────────────────────────────
test('TEST1: authorize → Duffel success → capture success → confirmed (1 order, 1 capture, 0 refund, 0 cancel)', async () => {
  const sid = 'cs_test1';
  await rememberBooking(sid, { offer_id: 'off_1', passengers: [{ type: 'adult' }], customer_amount: 113, currency: 'EUR' });
  happyDuffel({ orderId: 'ord_ok', bookingRef: 'REFOK' });
  mockPI.retrieve.mockResolvedValue({ id: 'pi_auth', status: 'requires_capture', created: Math.floor(Date.now() / 1000), currency: 'eur', amount: 11300 });
  mockPI.capture.mockResolvedValue({ id: 'pi_auth', status: 'succeeded', amount_received: 11300, currency: 'eur' });

  const out = await bookFromSession(sid, authorizedSession(sid));

  expect(out.order_id).toBe('ord_ok');
  expect(out.captured).toBe(true);
  expect(out.payment_status).toBe('captured');
  expect(out.booking_status).toBe('booking_confirmed');
  const orderCalls = mockDuffelFn.mock.calls.filter((c) => c[0] === 'POST' && c[1] === '/air/orders');
  expect(orderCalls.length).toBe(1);            // exactly one supplier booking
  expect(mockPI.capture).toHaveBeenCalledTimes(1);
  expect(mockRefundsCreate).not.toHaveBeenCalled();
  expect(mockPI.cancel).not.toHaveBeenCalled();
});

// ─── TEST 2 / 3 — DUFFEL FAILURE → CANCEL AUTHORIZATION, NO REFUND ──
test('TEST2/3: authorize → Duffel failure → cancel authorization (0 capture, 0 refund)', async () => {
  const sid = 'cs_test2';
  await rememberBooking(sid, { offer_id: 'off_1', passengers: [{ type: 'adult' }], customer_amount: 113, currency: 'EUR' });
  failingDuffel('offer_no_longer_available');
  mockPI.retrieve.mockResolvedValue({ id: 'pi_auth', status: 'requires_capture', created: Math.floor(Date.now() / 1000), currency: 'eur' });
  mockPI.cancel.mockResolvedValue({ id: 'pi_auth', status: 'canceled' });

  await expect(bookFromSession(sid, authorizedSession(sid))).rejects.toMatchObject({ cancelled: true, refunded: false });

  expect(mockPI.cancel).toHaveBeenCalledTimes(1);   // authorization released
  expect(mockPI.capture).not.toHaveBeenCalled();    // never captured
  expect(mockRefundsCreate).not.toHaveBeenCalled(); // and NEVER refunded
});

// ─── TEST 4 — PRICE CHANGED → CANCEL AUTHORIZATION, NO REFUND ────
test('TEST4: authorize → unacceptable price rise → cancel authorization (0 capture, 0 refund)', async () => {
  const sid = 'cs_test4';
  // Authorized 100, but the live offer now recomputes to 200 (>5 drift).
  await rememberBooking(sid, { offer_id: 'off_1', passengers: [{ type: 'adult' }], customer_amount: 100, currency: 'EUR' });
  happyDuffel({ orderId: 'ord_x', offerTotal: '200' });  // fresh price 200
  mockPI.retrieve.mockResolvedValue({ id: 'pi_auth', status: 'requires_capture', created: Math.floor(Date.now() / 1000), currency: 'eur' });
  mockPI.cancel.mockResolvedValue({ id: 'pi_auth', status: 'canceled' });

  await expect(bookFromSession(sid, authorizedSession(sid))).rejects.toMatchObject({ code: 'PRICE_DRIFT', cancelled: true });

  expect(mockPI.cancel).toHaveBeenCalledTimes(1);
  expect(mockPI.capture).not.toHaveBeenCalled();
  expect(mockRefundsCreate).not.toHaveBeenCalled();
  // No supplier order was created either (blocked before /air/orders).
  expect(mockDuffelFn.mock.calls.some((c) => c[0] === 'POST' && c[1] === '/air/orders')).toBe(false);
});

// ─── TEST 8 — ALREADY TRUE (idempotent) ─────────────────────────
test('TEST8: confirm after success returns existing booking, no 2nd order, no 2nd capture', async () => {
  const sid = 'cs_test8';
  await rememberBooking(sid, { offer_id: 'off_1', passengers: [{ type: 'adult' }], customer_amount: 149.9, currency: 'EUR' });
  const { markPendingBooked } = require('../src/services/pendingBookings');
  await markPendingBooked(sid, 'ord_done', 'REFDONE');
  // PI already captured — recovery capture is a no-op.
  mockPI.retrieve.mockResolvedValue({ id: 'pi_auth', status: 'succeeded', amount_received: 14990, currency: 'eur' });

  const out = await bookFromSession(sid, authorizedSession(sid));

  expect(out.already).toBe(true);
  expect(out.order_id).toBe('ord_done');
  expect(mockDuffelFn.mock.calls.some((c) => c[0] === 'POST' && c[1] === '/air/orders')).toBe(false);
  expect(mockPI.capture).not.toHaveBeenCalled();
});

// ─── TEST 5 — CAPTURE RECOVERY on already-path (double-click race) ──
test('TEST5: already-booked but still authorized → recovery captures once, no 2nd order', async () => {
  const sid = 'cs_test5';
  await rememberBooking(sid, { offer_id: 'off_1', passengers: [{ type: 'adult' }], customer_amount: 120, currency: 'EUR' });
  const { markPendingBooked } = require('../src/services/pendingBookings');
  await markPendingBooked(sid, 'ord_r', 'REFR');
  mockPI.retrieve.mockResolvedValue({ id: 'pi_auth', status: 'requires_capture', created: Math.floor(Date.now() / 1000), currency: 'eur' });
  mockPI.capture.mockResolvedValue({ id: 'pi_auth', status: 'succeeded', amount_received: 12000, currency: 'eur' });

  const out = await bookFromSession(sid, authorizedSession(sid));

  expect(out.already).toBe(true);
  expect(mockPI.capture).toHaveBeenCalledTimes(1);   // recovered the capture
  expect(mockDuffelFn.mock.calls.some((c) => c[0] === 'POST' && c[1] === '/air/orders')).toBe(false); // never a 2nd order
});

// ─── TEST 9 — DUFFEL SUCCESS + CAPTURE FAILURE → MANUAL REVIEW ───
test('TEST9: Duffel success + capture failure → manual review, no 2nd order, no refund', async () => {
  const sid = 'cs_test9';
  await rememberBooking(sid, { offer_id: 'off_1', passengers: [{ type: 'adult' }], customer_amount: 113, currency: 'EUR' });
  happyDuffel({ orderId: 'ord_mr', bookingRef: 'REFMR' });
  mockPI.retrieve.mockResolvedValue({ id: 'pi_auth', status: 'requires_capture', created: Math.floor(Date.now() / 1000), currency: 'eur' });
  const capErr = new Error('card_declined'); capErr.code = 'card_declined';
  mockPI.capture.mockRejectedValue(capErr);

  await expect(bookFromSession(sid, authorizedSession(sid))).rejects.toMatchObject({
    code: 'CAPTURE_FAILED_AFTER_BOOKING', manualReview: true, order_id: 'ord_mr',
  });

  const orderCalls = mockDuffelFn.mock.calls.filter((c) => c[0] === 'POST' && c[1] === '/air/orders');
  expect(orderCalls.length).toBe(1);                 // the flight IS booked, exactly once
  expect(mockRefundsCreate).not.toHaveBeenCalled();  // NOT refunded (money still authorized)
  expect(mockPI.cancel).not.toHaveBeenCalled();      // NOT cancelled (booking exists)
});

// ─── TEST 10 — BROWSER CLOSED (webhook-style, no session email) ──
test('TEST10: booking completes from a session object alone (browser-independent)', async () => {
  const sid = 'cs_test10';
  await rememberBooking(sid, { offer_id: 'off_1', passengers: [{ type: 'adult' }], customer_amount: 113, currency: 'EUR' });
  happyDuffel({ orderId: 'ord_bg', bookingRef: 'REFBG' });
  mockPI.retrieve.mockResolvedValue({ id: 'pi_auth', status: 'requires_capture', created: Math.floor(Date.now() / 1000), currency: 'eur' });
  mockPI.capture.mockResolvedValue({ id: 'pi_auth', status: 'succeeded', amount_received: 10000, currency: 'eur' });

  const out = await bookFromSession(sid, { id: sid, payment_intent: 'pi_auth', status: 'complete' });
  expect(out.captured).toBe(true);
  expect(out.order_id).toBe('ord_bg');
});

// ─── TEST 12 — AUTHORIZATION EXPIRED (capture on a cancelled PI) ─
test('TEST12: capturing an expired/cancelled authorization is refused, not blindly retried', async () => {
  mockPI.retrieve.mockResolvedValue({ id: 'pi_exp', status: 'canceled' });
  await expect(payments.captureAuthorizedPayment('pi_exp', { sessionId: 'cs_exp' }))
    .rejects.toMatchObject({ code: 'CAPTURE_ON_CANCELLED' });
  expect(mockPI.capture).not.toHaveBeenCalled();
});

// ─── payments service unit tests: capture/cancel idempotency ─────
test('captureAuthorizedPayment short-circuits an already-succeeded PI (no double capture)', async () => {
  mockPI.retrieve.mockResolvedValue({ id: 'pi_s', status: 'succeeded', amount_received: 5000, currency: 'eur' });
  const r = await payments.captureAuthorizedPayment('pi_s', { sessionId: 'cs_s' });
  expect(r.captured).toBe(true);
  expect(r.alreadyCaptured).toBe(true);
  expect(mockPI.capture).not.toHaveBeenCalled();
});

test('cancelAuthorization on an already-cancelled PI is idempotent (no throw)', async () => {
  mockPI.retrieve.mockResolvedValue({ id: 'pi_c', status: 'canceled' });
  const r = await payments.cancelAuthorization('pi_c', { sessionId: 'cs_c' });
  expect(r.cancelled).toBe(true);
  expect(mockPI.cancel).not.toHaveBeenCalled();
});

test('cancelAuthorization refuses to cancel a captured PI (reports cannotCancel)', async () => {
  mockPI.retrieve.mockResolvedValue({ id: 'pi_cap', status: 'succeeded' });
  const r = await payments.cancelAuthorization('pi_cap', { sessionId: 'cs_cap' });
  expect(r.cancelled).toBe(false);
  expect(r.cannotCancel).toBe(true);
  expect(mockPI.cancel).not.toHaveBeenCalled();
});

// ─── reconciliation mismatch classifier (brief §32) ─────────────
describe('detectLifecycleMismatch', () => {
  const D = payments.detectLifecycleMismatch;
  test('consistent captured+confirmed booking → no finding', () => {
    expect(D({ duffel_order_id: 'o', payment_status: 'captured', booking_status: 'booking_confirmed' })).toBeNull();
  });
  test('CASE A: order without capture → CRITICAL manual review', () => {
    const f = D({ duffel_order_id: 'o', payment_status: 'authorized', booking_status: 'booking_pending_supplier' });
    expect(f).toMatchObject({ code: 'ORDER_WITHOUT_CAPTURE', manualReview: true });
  });
  test('CASE B: captured but not confirmed → CRITICAL manual review', () => {
    const f = D({ duffel_order_id: 'o', payment_status: 'captured', booking_status: 'booking_failed' });
    expect(f).toMatchObject({ code: 'CAPTURE_WITHOUT_CONFIRMED_BOOKING', manualReview: true });
  });
  test('CASE C: expired authorization, no order → review', () => {
    const f = D({ payment_status: 'authorized', authorization_expires_at: new Date(Date.now() - 1000).toISOString() });
    expect(f).toMatchObject({ code: 'AUTHORIZATION_EXPIRED_ABANDONED', manualReview: true });
  });
  test('CASE E: duplicate supplier order → CRITICAL', () => {
    const f = D({ duffel_order_id: 'o', payment_status: 'captured', booking_status: 'booking_confirmed', duffel_order_count: 2 });
    expect(f).toMatchObject({ code: 'DUPLICATE_SUPPLIER_ORDER', manualReview: true });
  });
  test('capture_failed flagged → review', () => {
    const f = D({ duffel_order_id: 'o', payment_status: 'capture_failed', booking_status: 'manual_review_required' });
    expect(f).toMatchObject({ manualReview: true });
  });
});
