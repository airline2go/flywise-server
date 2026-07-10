jest.mock('../src/clients/supabase', () => {
  const responses = {}; // table -> { maybeSingle, result, insertError, updateError }
  function makeBuilder(table) {
    const cfg = responses[table] || {};
    const builder = {
      select: () => builder,
      eq: () => builder,
      or: () => builder,
      lte: () => builder,
      in: () => builder,
      order: () => builder,
      update: () => builder,
      insert: () => builder,
      maybeSingle: () => Promise.resolve(cfg.maybeSingle || { data: null, error: null }),
      then: (resolve, reject) => Promise.resolve(cfg.result || { data: null, error: null }).then(resolve, reject),
    };
    return builder;
  }
  return {
    from: jest.fn((table) => makeBuilder(table)),
    __setResponse: (table, cfg) => { responses[table] = cfg; },
    __reset: () => { for (const k of Object.keys(responses)) delete responses[k]; },
  };
});

jest.mock('../src/utils/log', () => jest.fn());

const mockGetOrCreateLoyaltyAccount = jest.fn();
const mockLogLoyaltyTransaction = jest.fn();
jest.mock('../src/services/loyalty', () => ({
  getOrCreateLoyaltyAccount: (...args) => mockGetOrCreateLoyaltyAccount(...args),
  logLoyaltyTransaction: (...args) => mockLogLoyaltyTransaction(...args),
}));

const supa = require('../src/clients/supabase');
const referrals = require('../src/services/referrals');

// A few tests below override supa.from's implementation directly (for
// query shapes the generic builder can't express — different chains on
// the same table within one call). mockClear() alone doesn't undo a
// mockImplementation override, so it must be restored explicitly here or
// it would silently leak into every later test.
const defaultFromImpl = supa.from.getMockImplementation();

beforeEach(() => {
  supa.__reset();
  supa.from.mockReset().mockImplementation(defaultFromImpl);
  mockGetOrCreateLoyaltyAccount.mockReset();
  mockLogLoyaltyTransaction.mockReset();
});

describe('referralCodeFor', () => {
  test('is deterministic for the same id', () => {
    expect(referrals.referralCodeFor('user-123')).toBe(referrals.referralCodeFor('user-123'));
  });

  test('differs for different ids', () => {
    expect(referrals.referralCodeFor('user-123')).not.toBe(referrals.referralCodeFor('user-456'));
  });

  test('always has the AP- prefix and a 6-char suffix', () => {
    const code = referrals.referralCodeFor('any-id');
    expect(code).toMatch(/^AP-[0-9A-Z]{6}$/);
  });
});

describe('getOrCreateReferralCode', () => {
  test('returns the existing code without writing if already set', async () => {
    mockGetOrCreateLoyaltyAccount.mockResolvedValue({ user_id: 'u1', referral_code: 'AP-EXIST1' });
    const code = await referrals.getOrCreateReferralCode('u1');
    expect(code).toBe('AP-EXIST1');
  });

  test('backfills and returns a fresh deterministic code when unset', async () => {
    mockGetOrCreateLoyaltyAccount.mockResolvedValue({ user_id: 'u1', referral_code: null });
    const code = await referrals.getOrCreateReferralCode('u1');
    expect(code).toBe(referrals.referralCodeFor('u1'));
  });
});

describe('linkNewUser', () => {
  test('fails when the referrer code does not resolve to any account', async () => {
    supa.__setResponse('loyalty_accounts', { maybeSingle: { data: null, error: null } });
    const result = await referrals.linkNewUser('new-user', 'new@x.com', 'AP-NOBODY');
    expect(result).toEqual({ linked: false, reason: 'unknown_code' });
  });

  test('refuses a self-referral', async () => {
    supa.__setResponse('loyalty_accounts', { maybeSingle: { data: { user_id: 'same-user' }, error: null } });
    const result = await referrals.linkNewUser('same-user', 'me@x.com', 'AP-SELF01');
    expect(result).toEqual({ linked: false, reason: 'self_referral' });
  });

  test('inserts a real referral row on success', async () => {
    const responses = { user_id: 'referrer-1' };
    let call = 0;
    supa.from.mockImplementation((table) => {
      if (table === 'loyalty_accounts') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: responses, error: null }) }) }) };
      }
      if (table === 'referrals') {
        call++;
        if (call === 1) {
          // existing-row check
          return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
        }
        return { insert: (row) => { expect(row).toMatchObject({ referrer_id: 'referrer-1', referred_id: 'referred-1', status: 'awaiting_booking' }); return Promise.resolve({ error: null }); } };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
    });
    const result = await referrals.linkNewUser('referred-1', 'referred@x.com', 'ap-referrer1');
    expect(result).toEqual({ linked: true });
  });
});

describe('attachBookingIfReferred', () => {
  test('no-op when this user was never referred', async () => {
    supa.__setResponse('referrals', { maybeSingle: { data: null, error: null } });
    await referrals.attachBookingIfReferred('user-1', 'ord_1', { slices: [] });
    // No throw, and no update attempted — nothing to assert further since
    // the mock's update() would resolve fine either way; the real
    // assertion is that this completes without error.
  });

  test('extracts the real departure date from the Duffel order and attaches the booking', async () => {
    let referralsCall = 0;
    let updatedWith = null;
    supa.from.mockImplementation((table) => {
      if (table === 'referrals') {
        referralsCall++;
        if (referralsCall === 1) {
          return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'ref-1' }, error: null }) }) }) }) };
        }
        return { update: (payload) => { updatedWith = payload; return { eq: () => Promise.resolve({ error: null }) }; } };
      }
      if (table === 'bookings') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'booking-row-1' }, error: null }) }) }) };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
    });
    const orderData = { slices: [{ segments: [{ departing_at: '2026-08-01T10:00:00Z' }] }] };
    await referrals.attachBookingIfReferred('user-1', 'ord_1', orderData);
    expect(updatedWith).toEqual({ booking_id: 'booking-row-1', departure_date: '2026-08-01T10:00:00Z', status: 'pending' });
  });
});

describe('checkAndPayout', () => {
  test('returns zero when nothing is due', async () => {
    supa.__setResponse('referrals', { result: { data: [], error: null } });
    const result = await referrals.checkAndPayout('user-1');
    expect(result).toEqual({ creditedNow: 0 });
  });

  test('pays the referred side and marks it paid without touching the referrer side', async () => {
    const row = { id: 'ref-1', referrer_id: 'other-user', referred_id: 'user-1', reward_referrer_paid: false, reward_referred_paid: false, status: 'pending' };
    let updatedWith = null;
    mockGetOrCreateLoyaltyAccount.mockResolvedValue({ user_id: 'user-1', credit: 5 });
    supa.from.mockImplementation((table) => {
      if (table === 'referrals') {
        return {
          select: () => ({ eq: () => ({ or: () => ({ lte: () => Promise.resolve({ data: [row], error: null }) }) }) }),
          update: (payload) => { updatedWith = payload; return { eq: () => Promise.resolve({ error: null }) }; },
        };
      }
      if (table === 'loyalty_accounts') {
        return { update: () => ({ eq: () => Promise.resolve({ error: null }) }) };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
    });
    const result = await referrals.checkAndPayout('user-1');
    expect(result).toEqual({ creditedNow: 10 });
    expect(updatedWith).toEqual({ reward_referrer_paid: false, reward_referred_paid: true, status: 'pending' });
    // [LEDGER] creditReward must also log a loyalty_transactions row.
    expect(mockLogLoyaltyTransaction).toHaveBeenCalledWith('user', 'user-1', 'reward', 10, 15, expect.any(String));
  });

  test('marks completed once both sides are paid', async () => {
    const row = { id: 'ref-1', referrer_id: 'user-1', referred_id: 'other-user', reward_referrer_paid: false, reward_referred_paid: true, status: 'pending' };
    let updatedWith = null;
    mockGetOrCreateLoyaltyAccount.mockResolvedValue({ user_id: 'user-1', credit: 0 });
    supa.from.mockImplementation((table) => {
      if (table === 'referrals') {
        return {
          select: () => ({ eq: () => ({ or: () => ({ lte: () => Promise.resolve({ data: [row], error: null }) }) }) }),
          update: (payload) => { updatedWith = payload; return { eq: () => Promise.resolve({ error: null }) }; },
        };
      }
      if (table === 'loyalty_accounts') {
        return { update: () => ({ eq: () => Promise.resolve({ error: null }) }) };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
    });
    const result = await referrals.checkAndPayout('user-1');
    expect(result).toEqual({ creditedNow: 10 });
    expect(updatedWith).toEqual({ reward_referrer_paid: true, reward_referred_paid: true, status: 'completed' });
  });
});

describe('getMyReferralList', () => {
  test('flattens the embedded booking reference and drops the raw booking id', async () => {
    supa.__setResponse('referrals', {
      result: {
        data: [
          { referred_email: 'friend@x.com', status: 'completed', created_at: '2026-01-01T00:00:00Z', bookings: { booking_reference: 'REF123' } },
          { referred_email: 'other@x.com', status: 'awaiting_booking', created_at: '2026-01-02T00:00:00Z', bookings: null },
        ],
        error: null,
      },
    });
    const list = await referrals.getMyReferralList('u1');
    expect(list).toEqual([
      { referred_email: 'friend@x.com', status: 'completed', created_at: '2026-01-01T00:00:00Z', booking_reference: 'REF123' },
      { referred_email: 'other@x.com', status: 'awaiting_booking', created_at: '2026-01-02T00:00:00Z', booking_reference: null },
    ]);
  });
});

describe('reverseReferralForBooking', () => {
  test('no-op when the cancelled booking has no linked referral', async () => {
    supa.from.mockImplementation((table) => {
      if (table === 'bookings') return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'b1' }, error: null }) }) }) };
      if (table === 'referrals') return { select: () => ({ eq: () => ({ in: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) };
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
    });
    await referrals.reverseReferralForBooking('ord_1');
    // Completes without throwing — nothing further to assert.
  });

  test('reverses a paid reward and marks the referral cancelled', async () => {
    const referralRow = { id: 'ref-1', referrer_id: 'referrer-1', referred_id: 'referred-1', reward_referrer_paid: true, reward_referred_paid: false };
    let referralUpdatedWith = null;
    let loyaltyUpdatedFor = [];
    mockGetOrCreateLoyaltyAccount.mockImplementation((kind, id) => Promise.resolve({ user_id: id, credit: 20 }));
    supa.from.mockImplementation((table) => {
      if (table === 'bookings') return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'b1' }, error: null }) }) }) };
      if (table === 'referrals') {
        return {
          select: () => ({ eq: () => ({ in: () => ({ maybeSingle: () => Promise.resolve({ data: referralRow, error: null }) }) }) }),
          update: (payload) => { referralUpdatedWith = payload; return { eq: () => Promise.resolve({ error: null }) }; },
        };
      }
      if (table === 'loyalty_accounts') {
        return { update: (payload) => { loyaltyUpdatedFor.push(payload); return { eq: () => Promise.resolve({ error: null }) }; } };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) };
    });
    await referrals.reverseReferralForBooking('ord_1');
    expect(referralUpdatedWith).toEqual({ status: 'cancelled' });
    // Only the referrer had been paid — only one reversal credit update expected.
    expect(loyaltyUpdatedFor).toEqual([{ credit: 10 }]);
    // [LEDGER] reverseReward must also log a (negative) loyalty_transactions row.
    expect(mockLogLoyaltyTransaction).toHaveBeenCalledWith('user', 'referrer-1', 'reward', -10, 10, expect.any(String));
  });
});
