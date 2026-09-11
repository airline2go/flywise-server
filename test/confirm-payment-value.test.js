/**
 * [ADS-CONVERSION] bookFromSession() value/currency contract.
 *
 * The Google Ads + GA4 purchase value downstream is derived from the
 * amount bookFromSession() returns. These tests lock in that:
 *   - the returned total_amount is the CUSTOMER-PAID amount (not the
 *     Duffel net/supplier amount), and
 *   - the idempotent `already:true` path still carries an authoritative
 *     total_amount + currency (never undefined/0) so a refresh / double
 *     confirm-payment / poll re-entry cannot emit a zero-value conversion.
 */

jest.mock('../src/clients/supabase', () => null);
jest.mock('../src/clients/stripe', () => ({ checkout: { sessions: {} } }));
jest.mock('../src/utils/log', () => jest.fn());
jest.mock('../src/clients/sentry', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock('../src/services/duffel', () => {
  const fn = jest.fn();
  fn.getDuffelCircuitStatus = () => ({ state: 'closed', consecutiveFailures: 0 });
  return fn;
});

const mockGetPendingBooking = jest.fn();
jest.mock('../src/services/pendingBookings', () => ({
  getPendingBooking: (...a) => mockGetPendingBooking(...a),
  markPendingBooked: jest.fn(),
  setBookingStatus: jest.fn(),
}));

const { bookFromSession } = require('../src/services/booking');

describe('[ADS-CONVERSION] bookFromSession already:true value contract', () => {
  beforeEach(() => mockGetPendingBooking.mockReset());

  test('returns customer-paid total_amount + currency on the idempotent path', async () => {
    mockGetPendingBooking.mockResolvedValue({
      duffel_order_id: 'ord_123',
      duffel_ref: 'ABC123',
      payload: { customer_amount: 149.9, currency: 'EUR' },
    });

    const out = await bookFromSession('cs_test_already', {});

    expect(out.already).toBe(true);
    expect(out.order_id).toBe('ord_123');
    expect(out.booking_reference).toBe('ABC123');
    // customer-paid, NOT 0 / undefined
    expect(out.total_amount).toBe(149.9);
    expect(typeof out.total_amount).toBe('number');
    expect(out.currency).toBe('EUR');
  });

  test('already:true total_amount is null (not 0) when no amount was persisted', async () => {
    mockGetPendingBooking.mockResolvedValue({
      duffel_order_id: 'ord_456',
      duffel_ref: 'DEF456',
      payload: {},
    });

    const out = await bookFromSession('cs_test_already_noamt', {});

    expect(out.already).toBe(true);
    // null signals "unknown" to the client so it can decide — never a
    // misleading 0-value conversion.
    expect(out.total_amount).toBeNull();
  });
});
