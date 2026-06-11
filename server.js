'use strict';

/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║        FlyWise — Render.com Server (Duffel Proxy)       ║
 * ║           Node.js / Express  — Production v3.4          ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * Entry point — wires middleware and routes, starts the server.
 * All logic lives in routes/, middleware/, services/, validators/, utils/.
 *
 * API surface (unchanged from v3.3):
 *   GET  /             → service info
 *   GET  /health       → config health check
 *   POST /search       → search offers
 *   GET  /offer/:id    → single offer + services
 *   POST /order        → create order
 *   GET  /order/:id    → fetch order
 *   POST /cancel       → cancel order
 */

const express      = require('express');
const helmet       = require('helmet');
const compression  = require('compression');

const logger        = require('./utils/logger');
const config        = require('./utils/config');
const requestId     = require('./middleware/requestId');
const requestLogger = require('./middleware/requestLogger');
const cors          = require('./middleware/cors');
const { generalLimiter } = require('./middleware/rateLimiters');
const errorHandler  = require('./middleware/errorHandler');

const healthRoutes  = require('./routes/health');
const searchRoutes  = require('./routes/search');
const offerRoutes   = require('./routes/offers');
const orderRoutes   = require('./routes/orders');

// ── App ───────────────────────────────────────────────────
const app = express();

// Trust Render proxy so rate-limiter and logs see the real client IP
app.set('trust proxy', 1);

// ── Core middleware (order matters) ───────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // needed for open API
  contentSecurityPolicy: false,                          // not a browser app
}));
app.use(compression());
app.use(express.json({ limit: '50kb' }));
app.use(requestId);
app.use(requestLogger);
app.use(cors);
app.use(generalLimiter);

// ── Routes ────────────────────────────────────────────────
// healthRoutes handles GET / and GET /health
app.use('/',       healthRoutes);

// POST /search
app.use('/search', searchRoutes);

// GET /offer/:id
app.use('/offer',  offerRoutes);

// POST /order, GET /order/:id, POST /cancel (all in orders router)
// /cancel is mounted at /order level so router.post('/cancel') maps to POST /cancel
// But API contract requires POST /cancel at root — mount orders router at root too
app.use('/order',  orderRoutes);   // → POST /order, GET /order/:id, POST /order/cancel
app.use('/',       orderRoutes);   // → POST /cancel (router.post('/cancel'))

// ── 404 ───────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    ok:    false,
    error: `Route ${req.method} ${req.path} not found`,
    reqId: req.id,
  });
});

// ── Centralized error handler (must have 4 params) ────────
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────
const server = app.listen(config.PORT, () => {
  logger.info({
    port:         config.PORT,
    env:          process.env.NODE_ENV || 'development',
    cors:         config.ALLOWED_ORIGINS.join(', '),
    fetchTimeout: `${config.FETCH_TIMEOUT_MS}ms`,
    retryMax:     config.RETRY_MAX,
    rateLimits:   { search: '30/min', general: '120/min' },
  }, `FlyWise Server ready on port ${config.PORT}`);
});

// ── Graceful Shutdown ─────────────────────────────────────
function shutdown(signal) {
  logger.info({ signal }, 'Shutdown signal received — draining connections');
  server.close(err => {
    if (err) { logger.error({ err }, 'Error while closing server'); process.exit(1); }
    logger.info('Server shut down cleanly');
    process.exit(0);
  });
  // Force exit after 10 s if keep-alive connections are still open
  setTimeout(() => {
    logger.warn('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('unhandledRejection', reason => {
  logger.error({ reason: String(reason) }, 'Unhandled promise rejection');
});

process.on('uncaughtException', err => {
  logger.fatal({ err: { message: err.message, stack: err.stack } },
    'Uncaught exception — shutting down');
  process.exit(1);
});

module.exports = app; // exported for tests
