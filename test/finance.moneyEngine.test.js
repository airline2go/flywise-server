const { amountToMinor, minorToAmount, buildMoney, isConvertible, FX_SOURCE } = require('../src/services/finance/moneyEngine');

describe('finance/moneyEngine', () => {
  test('decimal ↔ minor units, no float drift', () => {
    expect(amountToMinor(115.00, 'EUR')).toBe(11500);
    expect(amountToMinor(10.005, 'EUR')).toBe(1001);     // half-up, documented
    expect(minorToAmount(11500, 'EUR')).toBe(115);
    expect(amountToMinor(1000, 'JPY')).toBe(1000);        // zero-decimal currency
  });

  test('EUR is identity — no external rate needed, provenance recorded', () => {
    const m = buildMoney({ amountMinor: 11500, currency: 'EUR' });
    expect(m.accounting_amount_eur_minor).toBe(11500);
    expect(m.exchange_rate).toBe(1);
    expect(m.exchange_rate_source).toBe(FX_SOURCE.SYSTEM);
    expect(isConvertible(m)).toBe(true);
  });

  test('foreign currency WITH a rate converts and records the source', () => {
    // 100.00 USD @ 0.9 → 90.00 EUR
    const m = buildMoney({ amountMinor: 10000, currency: 'USD', rate: 0.9, rateSource: FX_SOURCE.ECB });
    expect(m.original_amount_minor).toBe(10000);
    expect(m.original_currency).toBe('USD');
    expect(m.accounting_amount_eur_minor).toBe(9000);
    expect(m.exchange_rate_source).toBe(FX_SOURCE.ECB);
    expect(isConvertible(m)).toBe(true);
  });

  test('foreign currency WITHOUT a rate is NOT convertible (never guessed)', () => {
    const m = buildMoney({ amountMinor: 10000, currency: 'USD' });
    expect(m.original_amount_minor).toBe(10000);
    expect(m.original_currency).toBe('USD');
    expect(m.accounting_amount_eur_minor).toBeNull();
    expect(isConvertible(m)).toBe(false);
  });
});
