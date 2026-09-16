const { buildPriceSnapshot } = require('../src/config/price');

describe('price snapshot currency truthfulness', () => {
  test('does not assume EUR when currency is missing', () => {
    const snapshot = buildPriceSnapshot({ price: 99, currency: null, checkedAt: new Date().toISOString(), source: 'live' });
    expect(snapshot.price).toBeNull();
    expect(snapshot.currency).toBeNull();
    expect(snapshot.isLive).toBe(false);
  });

  test('normalizes a valid ISO-style currency code', () => {
    const snapshot = buildPriceSnapshot({ price: 99, currency: 'eur', checkedAt: new Date().toISOString(), source: 'live' });
    expect(snapshot.price).toBe(99);
    expect(snapshot.currency).toBe('EUR');
    expect(snapshot.isLive).toBe(true);
  });

  test('rejects malformed currency codes', () => {
    const snapshot = buildPriceSnapshot({ price: 99, currency: 'EURO', checkedAt: new Date().toISOString(), source: 'live' });
    expect(snapshot.price).toBeNull();
    expect(snapshot.currency).toBeNull();
  });
});
