// [SECURITY · OPEN-REDIRECT · §3] Regression tests for the Stripe
// success_url/cancel_url whitelist. The default ALLOWED_ORIGINS (no env
// override in tests) is airpiv.com, www.airpiv.com, flywise-app-amber.vercel.app.

const {
  sanitizeRedirectUrl,
  appendQueryParam,
  buildCheckoutRedirects,
} = require('../src/utils/redirectUrls');

describe('sanitizeRedirectUrl — whitelist enforcement', () => {
  test('accepts a whitelisted Airpiv URL and preserves its path', () => {
    expect(sanitizeRedirectUrl('https://airpiv.com/booking-confirmation', '/fallback'))
      .toBe('https://airpiv.com/booking-confirmation');
  });

  test('accepts the www + vercel whitelisted origins', () => {
    expect(sanitizeRedirectUrl('https://www.airpiv.com/x', '/f')).toBe('https://www.airpiv.com/x');
    expect(sanitizeRedirectUrl('https://flywise-app-amber.vercel.app/y', '/f'))
      .toBe('https://flywise-app-amber.vercel.app/y');
  });

  test('rejects an external domain and falls back to the canonical base', () => {
    expect(sanitizeRedirectUrl('https://evil.com/phish', '/booking-confirmation'))
      .toBe('https://airpiv.com/booking-confirmation');
  });

  test('rejects a look-alike subdomain (airpiv.com.evil.com)', () => {
    expect(sanitizeRedirectUrl('https://airpiv.com.evil.com/x', '/f'))
      .toBe('https://airpiv.com/f');
  });

  test('rejects javascript: URLs', () => {
    expect(sanitizeRedirectUrl('javascript:alert(1)', '/f')).toBe('https://airpiv.com/f');
  });

  test('rejects data: URLs', () => {
    expect(sanitizeRedirectUrl('data:text/html,<script>alert(1)</script>', '/f'))
      .toBe('https://airpiv.com/f');
  });

  test('rejects protocol-relative URLs (//evil.com)', () => {
    expect(sanitizeRedirectUrl('//evil.com/x', '/f')).toBe('https://airpiv.com/f');
  });

  test('rejects malformed URLs', () => {
    expect(sanitizeRedirectUrl('http://[not a url', '/f')).toBe('https://airpiv.com/f');
    expect(sanitizeRedirectUrl('not-a-url-at-all', '/f')).toBe('https://airpiv.com/f');
  });

  test('empty / missing URL falls back to the canonical base + path', () => {
    expect(sanitizeRedirectUrl('', '/booking-confirmation')).toBe('https://airpiv.com/booking-confirmation');
    expect(sanitizeRedirectUrl(undefined, '/booking-confirmation')).toBe('https://airpiv.com/booking-confirmation');
    expect(sanitizeRedirectUrl(null, '/')).toBe('https://airpiv.com/');
  });

  test('never trusts a spoofed origin embedded in a path/userinfo', () => {
    // userinfo trick: real host is evil.com, not airpiv.com
    expect(sanitizeRedirectUrl('https://airpiv.com@evil.com/x', '/f')).toBe('https://airpiv.com/f');
  });
});

describe('appendQueryParam — Stripe placeholder handling', () => {
  test('adds ? when the URL has no query string', () => {
    expect(appendQueryParam('https://airpiv.com/c', 'session_id', '{CHECKOUT_SESSION_ID}'))
      .toBe('https://airpiv.com/c?session_id={CHECKOUT_SESSION_ID}');
  });

  test('adds & when the URL already has a query string', () => {
    expect(appendQueryParam('https://airpiv.com/c?ref=1', 'session_id', '{CHECKOUT_SESSION_ID}'))
      .toBe('https://airpiv.com/c?ref=1&session_id={CHECKOUT_SESSION_ID}');
  });
});

describe('buildCheckoutRedirects — end-to-end shape', () => {
  test('valid Airpiv URLs pass through with the session placeholder appended', () => {
    const out = buildCheckoutRedirects('https://airpiv.com/success', 'https://airpiv.com/cancel', {
      successParam: 'session_id',
    });
    expect(out).toEqual({
      success_url: 'https://airpiv.com/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://airpiv.com/cancel',
    });
  });

  test('external URLs are replaced by safe defaults (no open redirect)', () => {
    const out = buildCheckoutRedirects('https://evil.com/a', 'https://evil.com/b', {
      successParam: 'add_session_id',
    });
    expect(out.success_url).toBe('https://airpiv.com/booking-confirmation?add_session_id={CHECKOUT_SESSION_ID}');
    expect(out.cancel_url).toBe('https://airpiv.com/');
  });

  test('honors a custom successParam (flight change flow)', () => {
    const out = buildCheckoutRedirects('https://airpiv.com/success', undefined, {
      successParam: 'change_session_id',
    });
    expect(out.success_url).toBe('https://airpiv.com/success?change_session_id={CHECKOUT_SESSION_ID}');
  });
});
