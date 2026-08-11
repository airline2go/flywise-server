// [F7 · MONEY · §26] Integer-minor-unit money helper. Covers the brief's
// required matrix: 0, 0.01, 10.99, large amounts, discounts, refunds,
// rounding, and currency-decimal handling.

const { toMinor, fromMinor, roundMoney, sumMoney, decimalsFor } = require('../src/utils/money');

describe('toMinor / fromMinor (EUR, 2 decimals)', () => {
  test.each([
    [0, 0],
    [0.01, 1],
    [10.99, 1099],
    [113, 11300],
    [9999.99, 999999],
    [1234567.89, 123456789],
  ])('toMinor(%p) = %p', (major, minor) => {
    expect(toMinor(major, 'EUR')).toBe(minor);
    expect(fromMinor(minor, 'EUR')).toBe(major);
  });

  test('non-numeric / null inputs are 0, never NaN', () => {
    expect(toMinor(undefined, 'EUR')).toBe(0);
    expect(toMinor(null, 'EUR')).toBe(0);
    expect(toMinor('abc', 'EUR')).toBe(0);
  });
});

describe('rounding policy (half-up, single documented point)', () => {
  test('rounds a fractional cent half-up', () => {
    expect(roundMoney(10.005, 'EUR')).toBe(10.01);
    expect(roundMoney(10.004, 'EUR')).toBe(10.0);
  });

  test('avoids the classic float artifact (1.005*100 = 100.4999…)', () => {
    // Naive Math.round(1.005*100)/100 gives 1.00; the helper gives 1.01.
    expect(roundMoney(1.005, 'EUR')).toBe(1.01);
  });

  test('a percentage discount rounds to a real chargeable amount', () => {
    // 15% off 99.99 = 84.9915 -> 84.99
    expect(roundMoney(99.99 * 0.85, 'EUR')).toBe(84.99);
  });
});

describe('sumMoney avoids accumulated float drift', () => {
  test('0.1 + 0.2 sums exactly to 0.30', () => {
    expect(sumMoney([0.1, 0.2], 'EUR')).toBe(0.3);
  });
  test('many small amounts stay exact', () => {
    const parts = Array(10).fill(0.1);
    expect(sumMoney(parts, 'EUR')).toBe(1.0);
  });
  test('refund (negative) nets correctly against a charge', () => {
    expect(sumMoney([113.0, -113.0], 'EUR')).toBe(0);
    expect(sumMoney([113.0, -50.0], 'EUR')).toBe(63.0);
  });
});

describe('currency decimals', () => {
  test('zero-decimal currency (JPY) uses whole units', () => {
    expect(decimalsFor('JPY')).toBe(0);
    expect(toMinor(1500, 'JPY')).toBe(1500);      // Stripe expects 1500, not 150000
    expect(fromMinor(1500, 'JPY')).toBe(1500);
  });
  test('three-decimal currency (BHD) uses thousandths', () => {
    expect(decimalsFor('BHD')).toBe(3);
    expect(toMinor(1.234, 'BHD')).toBe(1234);
  });
  test('unknown currency defaults to 2 decimals', () => {
    expect(decimalsFor('XYZ')).toBe(2);
    expect(toMinor(5, 'XYZ')).toBe(500);
  });
  test('currency is case-insensitive', () => {
    expect(toMinor(10.99, 'eur')).toBe(1099);
  });
});
