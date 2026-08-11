// [DURABLE-STATUS · §6] Unit tests for resolveBookingStatus(): in-memory
// value wins when present; otherwise it falls back to the durable
// pending_bookings row so status survives a process restart / works across
// instances.

let mockPendingRow = null;
jest.mock('../src/clients/supabase', () => ({
  from: () => ({
    select: function () { return this; },
    eq: function () { return this; },
    maybeSingle: () => Promise.resolve({ data: mockPendingRow, error: null }),
  }),
}));
jest.mock('../src/utils/log', () => jest.fn());

const {
  setBookingStatus,
  getBookingStatus,
  resolveBookingStatus,
} = require('../src/services/pendingBookings');

beforeEach(() => { mockPendingRow = null; });

test('returns the in-memory status when present (richest detail, no DB hit)', async () => {
  setBookingStatus('cs_mem', 'failed', { error: 'boom', refunded: true });
  const s = await resolveBookingStatus('cs_mem');
  expect(s.status).toBe('failed');
  expect(s.error).toBe('boom');
  expect(s.refunded).toBe(true);
});

test('falls back to the durable pending_bookings row when memory is empty', async () => {
  mockPendingRow = { status: 'booked', duffel_order_id: 'ord_7', duffel_ref: 'REF7' };
  // getBookingStatus (in-memory only) sees nothing for this session...
  expect(getBookingStatus('cs_restart')).toBeNull();
  // ...but the durable resolver recovers it from the DB.
  const s = await resolveBookingStatus('cs_restart');
  expect(s).toEqual({ status: 'booked', order_id: 'ord_7', booking_reference: 'REF7' });
});

test('returns null when neither memory nor DB has the session', async () => {
  mockPendingRow = null;
  expect(await resolveBookingStatus('cs_nowhere')).toBeNull();
});

test('null sessionId is handled safely', async () => {
  expect(await resolveBookingStatus(null)).toBeNull();
});
