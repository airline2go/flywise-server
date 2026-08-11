// [F8 · PROMO-RACE] incrementPromoUsage now delegates to the atomic
// increment_promo_usage RPC and reports whether the cap was hit.

let mockRpcImpl = () => Promise.resolve({ data: true, error: null });
jest.mock('../src/clients/supabase', () => ({
  rpc: (...args) => mockRpcImpl(...args),
  from: () => ({ select: function () { return this; }, eq: function () { return this; }, maybeSingle: () => Promise.resolve({ data: null, error: null }) }),
}));
jest.mock('../src/utils/log', () => jest.fn());
jest.mock('../src/services/duffel', () => { const f = () => Promise.resolve({}); f.getDuffelCircuitStatus = () => ({}); return f; });
jest.mock('../src/clients/stripe', () => ({ refunds: { create: jest.fn() } }));

const { incrementPromoUsage } = require('../src/services/booking');
const log = require('../src/utils/log');

beforeEach(() => { log.mockClear(); mockRpcImpl = () => Promise.resolve({ data: true, error: null }); });

test('calls the atomic RPC with the promo id and returns true on success', async () => {
  const calls = [];
  mockRpcImpl = (fn, args) => { calls.push([fn, args]); return Promise.resolve({ data: true, error: null }); };
  const ok = await incrementPromoUsage('promo_1');
  expect(ok).toBe(true);
  expect(calls[0]).toEqual(['increment_promo_usage', { p_promo_id: 'promo_1' }]);
});

test('returns false and logs when the usage cap has already been reached', async () => {
  mockRpcImpl = () => Promise.resolve({ data: false, error: null });
  const ok = await incrementPromoUsage('promo_capped');
  expect(ok).toBe(false);
  expect(log).toHaveBeenCalledWith('warn', 'promo_usage_cap_reached', { promoId: 'promo_capped' });
});

test('returns false and logs on an RPC error (never throws)', async () => {
  mockRpcImpl = () => Promise.resolve({ data: null, error: { message: 'db down' } });
  const ok = await incrementPromoUsage('promo_err');
  expect(ok).toBe(false);
  expect(log).toHaveBeenCalledWith('warn', 'promo_increment_rpc_failed', expect.objectContaining({ promoId: 'promo_err' }));
});

test('no-op (false) when no promo id is given', async () => {
  expect(await incrementPromoUsage(null)).toBe(false);
});
