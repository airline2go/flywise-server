const { clientIp, validIp } = require('../src/utils/clientIp');
const { getClientKey } = require('../src/middleware/rateLimit');
const { clientIp: searchGuardClientIp } = require('../src/middleware/searchGuard');

function request(headers = {}, remoteAddress = '10.0.0.8') {
  return { headers, socket: { remoteAddress } };
}

describe('client IP selection', () => {
  test('uses a valid Cloudflare client IP in preference to the proxy socket', () => {
    const req = request({ 'cf-connecting-ip': '203.0.113.42', 'x-forwarded-for': '198.51.100.9' });
    expect(clientIp(req)).toBe('203.0.113.42');
    expect(searchGuardClientIp(req)).toBe('203.0.113.42');
    expect(getClientKey(req)).toBe('203.0.113.42');
  });

  test('rejects malformed Cloudflare headers and never falls back to X-Forwarded-For', () => {
    const req = request({ 'cf-connecting-ip': '203.0.113.42, 198.51.100.9', 'x-forwarded-for': '198.51.100.9' }, '10.0.0.8');
    expect(clientIp(req)).toBe('10.0.0.8');
    expect(getClientKey(req)).toBe('10.0.0.8');
  });

  test('supports IPv6 and returns unknown only when neither header nor socket is valid', () => {
    expect(validIp('2001:db8::4')).toBe('2001:db8::4');
    expect(clientIp(request({ 'cf-connecting-ip': '2001:db8::4' }, '10.0.0.8'))).toBe('2001:db8::4');
    expect(clientIp(request({}, 'not-an-ip'))).toBe('unknown');
  });

  test('allows X-Forwarded-For only for an Express test app', () => {
    const req = request({ 'x-forwarded-for': '198.51.100.9' }, '10.0.0.8');
    req.app = { get: (key) => key === 'env' ? 'test' : undefined };
    expect(clientIp(req)).toBe('198.51.100.9');
  });
});
