'use strict';

const logger = require('./logger');

// ── Environment Detection ─────────────────────────────────
const IS_PROD = process.env.NODE_ENV === 'production';
const IS_TEST = process.env.NODE_ENV === 'test';
const ENV_NAME = IS_PROD ? 'production' : IS_TEST ? 'test' : 'development';

// ── Fail fast if required env vars are missing ────────────
const REQUIRED = ['DUFFEL_TOKEN'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  logger.fatal({ missing }, 'Missing required environment variables — cannot start');
  process.exit(1);
}

// ── Duffel Token Validation ───────────────────────────────
// Detect if using test vs live token
const DUFFEL_TOKEN = process.env.DUFFEL_TOKEN;
const IS_DUFFEL_TEST = DUFFEL_TOKEN.startsWith('duffel_test_');
const IS_DUFFEL_LIVE = DUFFEL_TOKEN.startsWith('duffel_live_');

if (!IS_DUFFEL_TEST && !IS_DUFFEL_LIVE) {
  logger.warn('DUFFEL_TOKEN format unrecognized — expected duffel_test_* or duffel_live_*');
}

if (IS_PROD && IS_DUFFEL_TEST) {
  logger.warn(
    '⚠️  Using DUFFEL TEST token in production environment! ' +
    'Set DUFFEL_TOKEN to a live token for real bookings.'
  );
}

// ── CORS Configuration ────────────────────────────────────
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
  : IS_PROD ? [] : ['*'];

if (IS_PROD && ALLOWED_ORIGINS.length === 0) {
  logger.warn(
    '⚠️  CORS: No ALLOWED_ORIGINS set in production. ' +
    'Set ALLOWED_ORIGINS=https://your-frontend-domain.com to restrict access.'
  );
  // Default to wildcard to avoid blocking (but log the warning)
  ALLOWED_ORIGINS.push('*');
}

if (IS_PROD && ALLOWED_ORIGINS.includes('*')) {
  logger.warn('CORS is set to "*" in production — set ALLOWED_ORIGINS to specific frontend origins');
}

// ── Rate Limiting ─────────────────────────────────────────
// More restrictive in production
const RATE_LIMIT_WINDOW_MS = IS_PROD ? 60_000 : 60_000;
const RATE_LIMIT_MAX       = IS_PROD ? 30 : 100;
const SEARCH_RATE_LIMIT_MAX = IS_PROD ? 10 : 30;

// ── Config Export ─────────────────────────────────────────
const config = {
  PORT:               Number(process.env.PORT)             || 3000,
  DUFFEL_TOKEN,
  DUFFEL_BASE:        'https://api.duffel.com',
  DUFFEL_VER:         'v2',
  FETCH_TIMEOUT_MS:   Number(process.env.FETCH_TIMEOUT_MS) || 15_000,
  RETRY_MAX:          Number(process.env.DUFFEL_RETRY_MAX) || 2,
  ALLOWED_ORIGINS,
  IS_PROD,
  IS_TEST,
  ENV_NAME,
  IS_DUFFEL_TEST,
  IS_DUFFEL_LIVE,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
  SEARCH_RATE_LIMIT_MAX,
};

// Log config summary on startup (without sensitive values)
logger.info({
  env:          ENV_NAME,
  port:         config.PORT,
  duffelMode:   IS_DUFFEL_TEST ? 'TEST' : IS_DUFFEL_LIVE ? 'LIVE' : 'UNKNOWN',
  cors:         ALLOWED_ORIGINS.join(', ') || '*',
  fetchTimeout: config.FETCH_TIMEOUT_MS + 'ms',
  retryMax:     config.RETRY_MAX,
}, 'FlyWise Server config loaded');

module.exports = config;
