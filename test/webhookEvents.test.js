// [F3/F5 · WEBHOOK-DURABILITY] Unit tests for the durable event store's
// begin/complete/fail idempotency logic.

let mockRow = null;         // existing stripe/duffel event row (or null)
let mockInsertError = null; // error returned by insert()

jest.mock('../src/clients/supabase', () => ({
  from: () => {
    const b = {
      select: () => b,
      eq: () => b,
      maybeSingle: () => Promise.resolve({ data: mockRow, error: null }),
      insert: () => Promise.resolve({ error: mockInsertError }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    };
    return b;
  },
}));
jest.mock('../src/utils/log', () => jest.fn());

const {
  beginStripeEvent, completeStripeEvent, failStripeEvent,
  beginDuffelEvent,
} = require('../src/services/webhookEvents');

beforeEach(() => { mockRow = null; mockInsertError = null; });

test('no event id → not durable, caller proceeds best-effort', async () => {
  const r = await beginStripeEvent({ type: 'checkout.session.completed', data: { object: {} } });
  expect(r).toEqual({ durable: false });
});

test('already-processed event → alreadyProcessed:true (skip)', async () => {
  mockRow = { status: 'processed', retry_count: 0 };
  const r = await beginStripeEvent({ id: 'evt_1', type: 'x', data: { object: {} } });
  expect(r).toEqual({ durable: true, alreadyProcessed: true });
});

test('previously-failed event → alreadyProcessed:false (retry)', async () => {
  mockRow = { status: 'processing_failed', retry_count: 2 };
  const r = await beginStripeEvent({ id: 'evt_2', type: 'x', data: { object: {} } });
  expect(r).toEqual({ durable: true, alreadyProcessed: false });
});

test('first-seen event (clean insert) → alreadyProcessed:false (process)', async () => {
  mockRow = null; mockInsertError = null;
  const r = await beginStripeEvent({ id: 'evt_3', type: 'x', data: { object: {} } });
  expect(r).toEqual({ durable: true, alreadyProcessed: false });
});

test('concurrent insert conflict (23505), race not yet processed → process', async () => {
  mockRow = null; // existing check: none
  mockInsertError = { code: '23505', message: 'duplicate key' };
  const r = await beginStripeEvent({ id: 'evt_4', type: 'x', data: { object: {} } });
  expect(r).toEqual({ durable: true, alreadyProcessed: false });
});

test('non-conflict insert error → not durable (fall back best-effort)', async () => {
  mockRow = null;
  mockInsertError = { code: '42P01', message: 'relation does not exist' };
  const r = await beginStripeEvent({ id: 'evt_5', type: 'x', data: { object: {} } });
  expect(r).toEqual({ durable: false });
});

test('duffel wrapper resolves the same way (already processed → skip)', async () => {
  mockRow = { status: 'processed', retry_count: 0 };
  const r = await beginDuffelEvent({ id: 'devt_1', type: 'order_cancellation.confirmed' });
  expect(r).toEqual({ durable: true, alreadyProcessed: true });
});

test('complete/fail never throw', async () => {
  await expect(completeStripeEvent('evt_9')).resolves.toBeUndefined();
  await expect(failStripeEvent('evt_9', 'boom')).resolves.toBeUndefined();
});
