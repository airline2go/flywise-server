// API bot shield
// The API is an application endpoint, not a crawlable website. Known
// search/AI/SEO crawlers are denied before they reach route handlers or
// expensive Duffel/Supabase work. robots.txt is also explicit for compliant
// crawlers. This is intentionally UA-based as a first line of defense;
// rate limits and application auth remain the authoritative controls.

const BOT_UA_PATTERN = /(?:googlebot|bingbot|bingpreview|yandexbot|baiduspider|duckduckbot|slurp|petalbot|bytespider|applebot|facebookexternalhit|facebot|twitterbot|linkedinbot|pinterestbot|semrushbot|ahrefsbot|mj12bot|dotbot|dataforseobot|rogerbot|screaming frog|siteauditbot|serpstatbot|gptbot|chatgpt-user|oai-searchbot|claudebot|ccbot|amazonbot|perplexitybot|cohere-ai|meta-externalagent|anthropic-ai|ia_archiver)/i;

const EXEMPT_PATHS = new Set([
  '/health',
  '/readiness',
  '/status',
  '/maintenance-status',
  '/robots.txt',
]);

module.exports = (app) => {
  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').set('Cache-Control', 'public, max-age=86400').send([
      'User-agent: *',
      'Disallow: /',
      '',
    ].join('\n'));
  });

  app.use((req, res, next) => {
    if (EXEMPT_PATHS.has(req.path)) return next();

    const ua = typeof req.headers['user-agent'] === 'string'
      ? req.headers['user-agent'].trim()
      : '';

    if (ua && BOT_UA_PATTERN.test(ua)) {
      res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
      return res.status(403).json({
        ok: false,
        error: 'Automated access to the Airpiv API is not permitted.',
      });
    }

    return next();
  });
};

module.exports.BOT_UA_PATTERN = BOT_UA_PATTERN;
