const sanitizeValue = require('../src/utils/sanitize');

describe('sanitizeValue', () => {
  test('strips control characters from strings', () => {
    const withControlChars = 'hello' + String.fromCharCode(7) + 'world';
    expect(sanitizeValue(withControlChars, 0)).toBe('helloworld');
  });

  test('truncates strings past 2000 chars', () => {
    const long = 'a'.repeat(2500);
    expect(sanitizeValue(long, 0).length).toBe(2000);
  });

  test('truncates arrays past 100 items', () => {
    const arr = Array.from({ length: 150 }, (_, i) => i);
    expect(sanitizeValue(arr, 0).length).toBe(100);
  });

  test('strips prototype-pollution keys from objects', () => {
    const malicious = JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1, "prototype": 1, "safe": "ok"}');
    const out = sanitizeValue(malicious, 0);
    expect(out).toEqual({ safe: 'ok' });
  });

  test('recurses into nested objects/arrays', () => {
    const out = sanitizeValue({ a: [{ b: 'cd' }] }, 0);
    expect(out).toEqual({ a: [{ b: 'cd' }] });
  });

  test('passes through numbers/booleans unchanged', () => {
    expect(sanitizeValue(42, 0)).toBe(42);
    expect(sanitizeValue(true, 0)).toBe(true);
  });

  test('stops recursing past depth 6', () => {
    expect(sanitizeValue('untouched', 7)).toBe('untouched');
  });
});
