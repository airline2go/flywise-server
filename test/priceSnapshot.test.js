// [PRICE-SNAPSHOT] Unit tests for the canonical price snapshot + central TTL.
// Pure functions, no I/O — they pin the exact "live vs stale" boundary and the
// fixed quote assumptions so a future edit can't silently loosen them.
const { buildPriceSnapshot, isPriceLive, PRICE_FRESHNESS_MS, PRICE_ASSUMPTIONS } = require('../src/config/price');

const NOW = Date.parse('2026-08-30T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

describe('isPriceLive', () => {
  test('fresh price (just checked) is live', () => {
    expect(isPriceLive(ago(60 * 1000), NOW)).toBe(true);
  });
  test('price exactly at the TTL boundary is still live', () => {
    expect(isPriceLive(ago(PRICE_FRESHNESS_MS), NOW)).toBe(true);
  });
  test('price older than the TTL is not live', () => {
    expect(isPriceLive(ago(PRICE_FRESHNESS_MS + 1000), NOW)).toBe(false);
  });
  test('missing / malformed checkedAt is not live', () => {
    expect(isPriceLive(null, NOW)).toBe(false);
    expect(isPriceLive('not-a-date', NOW)).toBe(false);
  });
  test('a future timestamp (clock skew) is not treated as live', () => {
    expect(isPriceLive(new Date(NOW + 60000).toISOString(), NOW)).toBe(false);
  });
});

describe('buildPriceSnapshot', () => {
  test('carries the fixed one-way / 1 adult / economy assumptions', () => {
    const s = buildPriceSnapshot({ price: 76, currency: 'EUR', checkedAt: ago(1000), source: 'live', offersCount: 22 }, NOW);
    expect(s.tripType).toBe(PRICE_ASSUMPTIONS.tripType);
    expect(s.passengers).toBe(1);
    expect(s.cabin).toBe('economy');
  });

  // Route WITH a live price (e.g. Ibiza → Frankfurt just priced).
  test('a fresh live price → isLive true, source live, offersCount preserved', () => {
    const s = buildPriceSnapshot({ price: 75.84, currency: 'EUR', checkedAt: ago(5 * 60 * 1000), source: 'live', offersCount: 22 }, NOW);
    expect(s).toMatchObject({ price: 75.84, currency: 'EUR', source: 'live', offersCount: 22, isLive: true });
  });

  // Reverse route (Frankfurt → Ibiza) behaves identically — snapshot is
  // direction-agnostic; freshness is what governs isLive.
  test('the reverse route with a fresh price is equally live', () => {
    const s = buildPriceSnapshot({ price: 80, currency: 'EUR', checkedAt: ago(10 * 60 * 1000), source: 'cache', offersCount: 9 }, NOW);
    expect(s.isLive).toBe(true);
    expect(s.source).toBe('cache');
  });

  // Route with a STALE price → served but never labelled live.
  test('a stale cached price → isLive false, source stale-cache', () => {
    const s = buildPriceSnapshot({ price: 78, currency: 'EUR', checkedAt: ago(PRICE_FRESHNESS_MS + 60 * 60 * 1000), source: 'stale-cache', offersCount: 6 }, NOW);
    expect(s.isLive).toBe(false);
    expect(s.price).toBe(78);
    expect(s.source).toBe('stale-cache');
  });

  // Route with NO live price at all.
  test('no price → null price/currency, isLive false, source none', () => {
    const s = buildPriceSnapshot({ source: 'none' }, NOW);
    expect(s).toMatchObject({ price: null, currency: null, isLive: false, source: 'none' });
  });

  test('a price with a stale timestamp can never be forced live', () => {
    // Even if a caller wrongly passed source:"live", isLive is derived from age.
    const s = buildPriceSnapshot({ price: 50, currency: 'EUR', checkedAt: ago(PRICE_FRESHNESS_MS * 3), source: 'live' }, NOW);
    expect(s.isLive).toBe(false);
  });
});
