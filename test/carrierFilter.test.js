const { isExcludedCarrier, EXCLUDED_IATA, EXCLUDED_NAMES } = require('../src/services/carrierFilter');

describe('isExcludedCarrier', () => {
  test('excludes Duffel test carrier by IATA code', () => {
    expect(isExcludedCarrier('ZZ', 'Duffel Airways')).toBe(true);
  });

  test('excludes by IATA code even if name looks real', () => {
    expect(isExcludedCarrier('ZZ', 'Some Airline')).toBe(true);
    expect(isExcludedCarrier('XX', 'Lufthansa')).toBe(true);
  });

  test('excludes by name even if IATA code is absent or different', () => {
    expect(isExcludedCarrier(null, 'Duffel Airways')).toBe(true);
    expect(isExcludedCarrier('AB', 'Unknown')).toBe(true);
  });

  test('is case- and whitespace-insensitive', () => {
    expect(isExcludedCarrier(' zz ', ' duffel airways ')).toBe(true);
    expect(isExcludedCarrier('Xx', 'UNKNOWN')).toBe(true);
  });

  test('keeps real operating carriers', () => {
    expect(isExcludedCarrier('LH', 'Lufthansa')).toBe(false);
    expect(isExcludedCarrier('FR', 'Ryanair')).toBe(false);
    expect(isExcludedCarrier('BA', 'British Airways')).toBe(false);
  });

  test('handles null/empty input without throwing', () => {
    expect(isExcludedCarrier(null, null)).toBe(false);
    expect(isExcludedCarrier('', '')).toBe(false);
    expect(isExcludedCarrier(undefined, undefined)).toBe(false);
  });

  test('exported sets contain the documented markers', () => {
    expect(EXCLUDED_IATA.has('ZZ')).toBe(true);
    expect(EXCLUDED_IATA.has('XX')).toBe(true);
    expect(EXCLUDED_NAMES.has('duffel airways')).toBe(true);
    expect(EXCLUDED_NAMES.has('unknown')).toBe(true);
  });
});
