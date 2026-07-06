jest.mock('../src/clients/supabase', () => null);
jest.mock('../src/utils/log', () => jest.fn());

const mockDuffelFn = jest.fn();
jest.mock('../src/services/duffel', () => {
  const fn = (...args) => mockDuffelFn(...args);
  fn.getDuffelCircuitStatus = () => ({ state: 'closed', consecutiveFailures: 0 });
  return fn;
});

const mockRefundsCreate = jest.fn().mockResolvedValue({});
jest.mock('../src/clients/stripe', () => ({
  refunds: { create: (...args) => mockRefundsCreate(...args) },
}));

const {
  computePromoDiscount,
  validateServices,
  attachPassengerIds,
  computeAuthoritativePricing,
  bookFromSession,
} = require('../src/services/booking');
const { rememberBooking, markPendingBooked, getBookingStatus } = require('../src/services/pendingBookings');

beforeEach(() => {
  mockDuffelFn.mockReset();
  mockRefundsCreate.mockClear();
  mockRefundsCreate.mockResolvedValue({});
});

describe('computePromoDiscount', () => {
  test('percent type computes a percentage of the subtotal', () => {
    expect(computePromoDiscount({ type: 'percent', value: 10 }, 200)).toBe(20);
  });

  test('fixed type returns the flat value', () => {
    expect(computePromoDiscount({ type: 'fixed', value: 15 }, 200)).toBe(15);
  });

  test('never discounts more than the subtotal', () => {
    expect(computePromoDiscount({ type: 'fixed', value: 500 }, 100)).toBe(100);
  });

  test('null promo row yields zero discount', () => {
    expect(computePromoDiscount(null, 200)).toBe(0);
  });

  test('negative value is clamped to zero', () => {
    expect(computePromoDiscount({ type: 'fixed', value: -50 }, 200)).toBe(0);
  });
});

describe('validateServices', () => {
  const available = [
    { id: 'svc_bag', maximum_quantity: 2 },
    { id: 'svc_seat', maximum_quantity: 1 },
  ];

  test('empty input returns empty array without touching duffel', async () => {
    const result = await validateServices('off_1', [], available);
    expect(result).toEqual([]);
    expect(mockDuffelFn).not.toHaveBeenCalled();
  });

  test('drops a service not present in the available list', async () => {
    const result = await validateServices('off_1', [{ id: 'svc_unknown', quantity: 1 }], available);
    expect(result).toEqual([]);
  });

  test('clamps quantity to the service maximum', async () => {
    const result = await validateServices('off_1', [{ id: 'svc_bag', quantity: 5 }], available);
    expect(result).toEqual([{ id: 'svc_bag', quantity: 2 }]);
  });

  test('keeps a valid service within its limit unchanged', async () => {
    const result = await validateServices('off_1', [{ id: 'svc_seat', quantity: 1 }], available);
    expect(result).toEqual([{ id: 'svc_seat', quantity: 1 }]);
  });
});

describe('attachPassengerIds', () => {
  test('maps passenger ids by type and pairs each infant with an adult', async () => {
    mockDuffelFn.mockResolvedValueOnce({
      data: {
        passengers: [
          { id: 'pax_adult_1', type: 'adult' },
          { id: 'pax_infant_1', type: 'infant_without_seat' },
        ],
      },
    });

    const result = await attachPassengerIds('off_1', [
      { type: 'adult', given_name: 'Anna' },
      { type: 'infant_without_seat', given_name: 'Baby' },
    ]);

    expect(result[0]).toMatchObject({ type: 'adult', given_name: 'Anna', id: 'pax_adult_1' });
    expect(result[1]).toMatchObject({ type: 'infant_without_seat', given_name: 'Baby', id: 'pax_infant_1' });
    expect(result[0].infant_passenger_id).toBe('pax_infant_1');
  });
});

describe('computeAuthoritativePricing', () => {
  function mockOfferAndSeatMaps({ totalAmount, passengerCount = 1 }) {
    mockDuffelFn.mockImplementation((method, path) => {
      if (path.includes('/air/seat_maps')) return Promise.resolve({ data: [] });
      if (path.includes('return_available_services=true')) {
        return Promise.resolve({
          data: {
            total_amount: totalAmount,
            total_currency: 'EUR',
            passengers: Array.from({ length: passengerCount }, () => ({ type: 'adult' })),
            available_services: [],
          },
        });
      }
      return Promise.reject(new Error('unexpected duffel call: ' + path));
    });
  }

  test('applies the default ticket-tier margin to a net price with no promo/loyalty', async () => {
    mockOfferAndSeatMaps({ totalAmount: '100' });
    const result = await computeAuthoritativePricing('off_1', [], null, null, null, false);
    // DEFAULT_TICKET_TIERS: 0-200 => 8% + 5  =>  100*0.08+5 = 13
    expect(result.netTicketPrice).toBe(100);
    expect(result.ticketMargin).toBe(13);
    expect(result.duffelAmount).toBe(100);
    expect(result.preDiscountTotal).toBe(113);
    expect(result.customerAmount).toBe(113);
    expect(result.discount).toBe(0);
  });

  test('with no Supabase configured, a userId never yields a loyalty discount even when requested', async () => {
    mockOfferAndSeatMaps({ totalAmount: '100' });
    const result = await computeAuthoritativePricing('off_1', [], null, null, 'user_123', true);
    expect(result.loyaltyDiscount).toBe(0);
    expect(result.loyaltyAccount).toBeNull();
  });

  test('splits margin evenly per passenger for multi-passenger bookings', async () => {
    mockOfferAndSeatMaps({ totalAmount: '200', passengerCount: 2 });
    const result = await computeAuthoritativePricing('off_1', [], null, null, null, false);
    // netPerPassenger = 100 => margin 13 per passenger => 26 total
    expect(result.ticketMargin).toBe(26);
    expect(result.preDiscountTotal).toBe(226);
  });
});

describe('bookFromSession', () => {
  function mockHappyDuffel({ offerTotal = '100', orderId = 'ord_1', bookingRef = 'REF1' } = {}) {
    mockDuffelFn.mockImplementation((method, path) => {
      if (path.includes('/air/seat_maps')) return Promise.resolve({ data: [] });
      if (method === 'GET' && path.includes('return_available_services=true')) {
        return Promise.resolve({
          data: { total_amount: offerTotal, total_currency: 'EUR', passengers: [{ type: 'adult' }], available_services: [] },
        });
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

  test('is idempotent: an already-booked session returns immediately without touching Duffel', async () => {
    const sessionId = 'sess_idempotent';
    await rememberBooking(sessionId, { offer_id: 'off_1', passengers: [], customer_amount: 100 });
    await markPendingBooked(sessionId, 'ord_existing', 'REF_EXISTING');

    const result = await bookFromSession(sessionId, {});

    expect(result).toEqual({ already: true, order_id: 'ord_existing', booking_reference: 'REF_EXISTING' });
    expect(mockDuffelFn).not.toHaveBeenCalled();
  });

  test('blocks the booking and issues a full refund when the fare drifted up by more than €5', async () => {
    const sessionId = 'sess_price_drift';
    await rememberBooking(sessionId, {
      offer_id: 'off_1',
      passengers: [{ type: 'adult' }],
      services: [],
      customer_amount: 113, // quoted based on a 100 net fare
      duffel_amount: '100',
      currency: 'EUR',
    });
    // Offer got much more expensive since checkout-session creation.
    mockHappyDuffel({ offerTotal: '300' });

    const fakeSession = { payment_intent: 'pi_123' };
    await expect(bookFromSession(sessionId, fakeSession)).rejects.toMatchObject({ code: 'PRICE_DRIFT' });

    expect(mockRefundsCreate).toHaveBeenCalledWith({ payment_intent: 'pi_123' });
    expect(getBookingStatus(sessionId).status).toBe('failed_price_drift');
    expect(mockDuffelFn).not.toHaveBeenCalledWith('POST', '/air/orders', expect.anything(), expect.anything());
  });

  test('refunds the customer in full when Duffel rejects order creation after payment', async () => {
    const sessionId = 'sess_order_fail';
    await rememberBooking(sessionId, {
      offer_id: 'off_1',
      passengers: [{ type: 'adult' }],
      services: [],
      customer_amount: 113, // matches the recomputed price exactly — no drift
      duffel_amount: '100',
      currency: 'EUR',
    });
    mockDuffelFn.mockImplementation((method, path) => {
      if (path.includes('/air/seat_maps')) return Promise.resolve({ data: [] });
      if (method === 'GET' && path.includes('return_available_services=true')) {
        return Promise.resolve({ data: { total_amount: '100', total_currency: 'EUR', passengers: [{ type: 'adult' }], available_services: [] } });
      }
      if (method === 'GET' && /\/air\/offers\/off_1$/.test(path)) {
        return Promise.resolve({ data: { passengers: [{ id: 'pax_1', type: 'adult' }] } });
      }
      if (method === 'POST' && path === '/air/orders') {
        const err = new Error('offer_no_longer_available');
        err.status = 422;
        return Promise.reject(err);
      }
      return Promise.reject(new Error('unexpected duffel call: ' + method + ' ' + path));
    });

    const fakeSession = { payment_intent: 'pi_456' };
    await expect(bookFromSession(sessionId, fakeSession)).rejects.toMatchObject({
      code: 'ORDER_CREATE_FAILED',
      refunded: true,
    });

    expect(mockRefundsCreate).toHaveBeenCalledWith({ payment_intent: 'pi_456' });
    expect(getBookingStatus(sessionId).status).toBe('failed');
  });

  test('books successfully end to end when nothing drifts and Duffel accepts the order', async () => {
    const sessionId = 'sess_happy';
    await rememberBooking(sessionId, {
      offer_id: 'off_1',
      passengers: [{ type: 'adult', given_name: 'Anna', family_name: 'Muster', born_on: '1990-01-01' }],
      services: [],
      customer_amount: 113,
      duffel_amount: '100',
      currency: 'EUR',
    });
    mockHappyDuffel({ offerTotal: '100', orderId: 'ord_happy', bookingRef: 'REFHAPPY' });

    const result = await bookFromSession(sessionId, {});

    expect(result).toEqual({
      already: false,
      order_id: 'ord_happy',
      booking_reference: 'REFHAPPY',
      total_amount: '100',
      currency: 'EUR',
    });
    expect(getBookingStatus(sessionId).status).toBe('booked');
    expect(mockRefundsCreate).not.toHaveBeenCalled();
  });
});
