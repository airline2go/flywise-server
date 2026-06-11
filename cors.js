'use strict';

const { ALLOWED_ORIGINS } = require('./config');

/**
 * CORS middleware.
 * Respects ALLOWED_ORIGINS env var.
 *   - '*'                 → allow all (dev / open API)
 *   - specific origins    → allow only listed origins
 *
 * Set ALLOWED_ORIGINS=https://yourapp.com,https://www.yourapp.com in production.
 */
const cors = (req, res, next) => {
  const origin  = req.headers.origin || '';
  const allowed = ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin);

  if (allowed) {
    res.header(
      'Access-Control-Allow-Origin',
      ALLOWED_ORIGINS.includes('*') ? '*' : origin
    );
  }
  res.header('Access-Control-Allow-Methods',  'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers',  'Content-Type, Authorization, X-Request-Id');
  res.header('Access-Control-Expose-Headers', 'X-Request-Id');

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
};

module.exports = cors;
