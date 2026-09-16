const log = require('../utils/log');
const rateLimit = require('./rateLimit');

// Cheap gate before any Supabase work. This is intentionally conservative:
// only clearly automated clients are rejected; ordinary browsers remain
// available. Rate limiting is still the primary control.
const AUTOMATION_RE = /(curl|wget|python-requests|python-urllib|aiohttp|scrapy|httpclient|okhttp|go-http-client|libwww-perl|headlesschrome|phantomjs|selenium|playwright|puppeteer)/i;

function reviewsBotShield() {
  const burst = rateLimit('reviews_burst', 3, 10000);
  return async function (req, res, next) {
    const ua = String(req.headers['user-agent'] || '');
    if (!ua || AUTOMATION_RE.test(ua)) {
      log('warn', 'reviews_bot_block', { reqId: req.id, method: req.method, path: req.path });
      return res.status(403).json({ ok: false, error: 'Zugriff verweigert.' });
    }
    return burst(req, res, next);
  };
}

module.exports = reviewsBotShield;
