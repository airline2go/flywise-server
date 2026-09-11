// [REVIEWS-P0] Service-level tests for the trust-sensitive logic that must
// never depend on the client: verified-only-when-the-booking-is-really
// yours, server-side route resolution, one-per-booking duplicate handling,
// and the published-only aggregate. The Supabase client is mocked as a
// chainable query builder backed by an ordered result queue — tests enqueue
// the results the service's queries resolve to, in call order.

jest.mock('../src/clients/supabase', () => {
  let queue = [];
  const nextResult = () => (queue.length ? queue.shift() : { data: null, error: null, count: 0 });
  function makeBuilder() {
    const b = {};
    ['select', 'eq', 'order', 'range', 'insert'].forEach((m) => { b[m] = () => b; });
    b.maybeSingle = () => Promise.resolve(nextResult());
    b.then = (resolve, reject) => Promise.resolve(nextResult()).then(resolve, reject);
    return b;
  }
  return {
    from: () => makeBuilder(),
    __setQueue: (arr) => { queue = arr.slice(); },
    __reset: () => { queue = []; },
  };
});

jest.mock('../src/utils/log', () => jest.fn());

const supa = require('../src/clients/supabase');
const reviews = require('../src/services/reviews');

beforeEach(() => supa.__reset());

describe('submitReview — verified logic', () => {
  test('verified=true and route derived when the booking is really the user’s', async () => {
    supa.__setQueue([
      { data: { id: 'b1', user_id: 'u1', origin: 'BER', destination: 'BCN' }, error: null }, // booking lookup
      { data: { id: 'route-9' }, error: null },                                               // route_pages by iata
      { data: { id: 'rev1', status: 'pending', verified: true }, error: null },               // insert...select
    ]);
    const res = await reviews.submitReview('u1', { rating: 5, comment: 'clear info', booking_id: 'b1' });
    expect(res).toEqual({ ok: true, id: 'rev1', status: 'pending', verified: true });
  });

  test('verified via booking_ref (the browser only has the reference, not the uuid)', async () => {
    supa.__setQueue([
      { data: { id: 'b-uuid-1', user_id: 'u1', origin: 'BER', destination: 'BCN' }, error: null }, // booking by reference
      { data: { id: 'route-9' }, error: null },                                                     // route_pages by iata
      { data: { id: 'rev-ref', status: 'pending', verified: true }, error: null },                  // insert...select
    ]);
    const res = await reviews.submitReview('u1', { rating: 5, booking_ref: 'AP-ABC123' });
    expect(res).toEqual({ ok: true, id: 'rev-ref', status: 'pending', verified: true });
  });

  test('a booking that is NOT the caller’s is dropped — never grants verified', async () => {
    supa.__setQueue([
      { data: { id: 'b1', user_id: 'someone-else', origin: 'BER', destination: 'BCN' }, error: null }, // not owner
      { data: { id: 'rev2', status: 'pending', verified: false }, error: null },                        // insert...select
    ]);
    const res = await reviews.submitReview('u1', { rating: 4, booking_id: 'b1' });
    expect(res.ok).toBe(true);
    expect(res.verified).toBe(false);
  });

  test('invalid rating is rejected before any DB write', async () => {
    const res = await reviews.submitReview('u1', { rating: 7 });
    expect(res).toEqual({ ok: false, reason: 'invalid_rating' });
  });

  test('unauthenticated is rejected', async () => {
    const res = await reviews.submitReview(null, { rating: 5 });
    expect(res).toEqual({ ok: false, reason: 'unauthenticated' });
  });

  test('duplicate (user, booking) unique violation → reason duplicate', async () => {
    supa.__setQueue([
      { data: { id: 'b1', user_id: 'u1', origin: 'BER', destination: 'BCN' }, error: null }, // booking lookup
      { data: { id: 'route-9' }, error: null },                                               // route_pages
      { data: null, error: { code: '23505', message: 'duplicate key' } },                     // insert conflict
    ]);
    const res = await reviews.submitReview('u1', { rating: 5, booking_id: 'b1' });
    expect(res).toEqual({ ok: false, reason: 'duplicate' });
  });

  test('general review (no booking) resolves route from slug, verified=false', async () => {
    supa.__setQueue([
      { data: { id: 'route-slug-1' }, error: null },                          // resolveRouteIdBySlug
      { data: { id: 'rev3', status: 'pending', verified: false }, error: null }, // insert...select
    ]);
    const res = await reviews.submitReview('u1', { rating: 5, route_slug: 'berlin-barcelona' });
    expect(res.ok).toBe(true);
    expect(res.verified).toBe(false);
  });
});

describe('computeAggregate — published only', () => {
  test('average, count and distribution from per-bucket counts', async () => {
    // counts enqueued for rating = 1,2,3,4,5 in that order
    supa.__setQueue([
      { count: 2, error: null }, // 1★
      { count: 3, error: null }, // 2★
      { count: 8, error: null }, // 3★
      { count: 20, error: null }, // 4★
      { count: 150, error: null }, // 5★
    ]);
    const agg = await reviews.computeAggregate({ routeId: null });
    // sum = 1*2 + 2*3 + 3*8 + 4*20 + 5*150 = 2+6+24+80+750 = 862 ; total = 183
    expect(agg.count).toBe(183);
    expect(agg.average).toBe(Math.round((862 / 183) * 10) / 10); // 4.7
    expect(agg.distribution).toEqual({ 1: 2, 2: 3, 3: 8, 4: 20, 5: 150 });
  });

  test('zero published reviews → average null (so callers can skip rendering)', async () => {
    supa.__setQueue([
      { count: 0, error: null }, { count: 0, error: null }, { count: 0, error: null },
      { count: 0, error: null }, { count: 0, error: null },
    ]);
    const agg = await reviews.computeAggregate({ routeId: 'r1' });
    expect(agg.count).toBe(0);
    expect(agg.average).toBeNull();
  });
});

describe('cleanLikedTags via submitReview (only whitelisted tags survive)', () => {
  test('unknown tags are dropped, valid ones kept', async () => {
    let captured = null;
    // Re-mock insert to capture the row for this one assertion.
    const origFrom = supa.from;
    supa.from = () => {
      const b = {};
      ['select', 'eq', 'order', 'range'].forEach((m) => { b[m] = () => b; });
      b.insert = (row) => { captured = row; return b; };
      b.maybeSingle = () => Promise.resolve({ data: { id: 'x', status: 'pending', verified: false }, error: null });
      b.then = (res) => Promise.resolve({ data: null, error: null }).then(res);
      return b;
    };
    await reviews.submitReview('u1', { rating: 5, liked_tags: ['easy_search', 'not_a_real_tag', 'clear_prices'] });
    expect(captured.liked_tags).toEqual(['easy_search', 'clear_prices']);
    expect(captured.stars).toBe(5); // legacy column kept in sync
    supa.from = origFrom;
  });
});
