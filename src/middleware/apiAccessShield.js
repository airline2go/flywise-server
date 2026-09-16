const crypto = require('crypto');
const rateLimit = require('./rateLimit');
const { clientIp } = require('./searchGuard');
const env = require('../config/env');

// Second line of defense after apiBotShield:
// - only the production web origins may call the public API from a browser
// - requests without browser provenance are denied unless they carry API auth
// - a distributed burst limiter throttles scripted clients before route code
// This does not replace endpoint-specific auth/rate limits.
const EXEMPT_PATHS = new Set([
  '/health', '/readiness', '/status', '/maintenance-status', '/robots.txt',
]);
const EXEMPT_PREFIXES = ['/webhooks/'];
const AUTOMATION_RE = /(?:curl|wget|python|urllib|aiohttp|scrapy|httpclient|okhttp|go-http-client|libwww|headless|phantom|selenium|playwright|puppeteer|postman|insomnia|axios)/i;

function allowedOrigin(req) {
  const origin = String(req.headers.origin || '').replace(/\/+$/, '');
  if (origin && Array.isArray(env.ALLOWED_ORIGINS) && env.ALLOWED_ORIGINS.includes(origin)) return true;
  const referer = String(req.headers.referer || '');
  return Array.isArray(env.ALLOWED_ORIGINS) && env.ALLOWED_ORIGINS.some((allowed) => {
    try { return new URL(referer).origin === allowed; } catch (e) { return false; }
  });
}

function hasTrustedAuth(req) {
  const auth = String(req.headers.authorization || '');
  return /^Bearer\s+\S+/i.test(auth);
}

function shield(app) {
  const burst = rateLimit('api-edge-burst', 45, 10000);
  const sustained = rateLimit('api-edge-sustained', 240, 60000);

  app.use(async (req, res, next) => {
    if (EXEMPT_PATHS.has(req.path) || EXEMPT_PREFIXES.some((p) => req.path.startsWith(p))) return next();

    const ua = String(req.headers['user-agent'] || '').trim();
    if (!ua || AUTOMATION_RE.test(ua)) {
      res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
      return res.status(403).json({ ok: false, error: 'Direct automated API access is not permitted.' });
    }

    // Browser traffic from Airpiv carries an allowed Origin/Referer. Authenticated
    // admin/service calls are allowed without browser provenance and remain protected
    // by their own authorization middleware.
    if (!allowedOrigin(req) && !hasTrustedAuth(req)) {
      return res.status(403).json({ ok: false, error: 'API access is restricted.' });
    }

    return next();
  });

  // Rate-limit only after the cheap provenance gate, so rejected scanners do not
  // consume Redis counters. These are intentionally conservative global ceilings;
  // endpoint-specific limits still apply later.
  app.use(burst);
  app.use(sustained);
}

module.exports = shield;
module.exports.allowedOrigin = allowedOrigin;
module.exports.hasTrustedAuth = hasTrustedAuth;
module.exports.EXEMPT_PATHS = EXEMPT_PATHS;
