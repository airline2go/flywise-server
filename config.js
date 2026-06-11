'use strict';

const logger = require('./logger');

// ── Fail fast if required env vars are missing ────────────
const REQUIRED = ['DUFFEL_TOKEN'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  logger.fatal({ missing }, 'Missing required environment variables — cannot start');
  process.exit(1);
}

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
  : ['*'];

const IS_PROD = process.env.NODE_ENV === 'production';

if (IS_PROD && ALLOWED_ORIGINS.includes('*')) {
  logger.warn(
    'CORS is set to "*" in production — set ALLOWED_ORIGINS to specific frontend origins'
  );
}

module.exports = {
  PORT:             Number(process.env.PORT)             || 3000,
  DUFFEL_TOKEN:     process.env.DUFFEL_TOKEN,
  DUFFEL_BASE:      'https://api.duffel.com',
  DUFFEL_VER:       'v2',
  FETCH_TIMEOUT_MS: Number(process.env.FETCH_TIMEOUT_MS) || 15_000,
  RETRY_MAX:        Number(process.env.DUFFEL_RETRY_MAX) || 2,
  ALLOWED_ORIGINS,
  IS_PROD,
};
