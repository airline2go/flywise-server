'use strict';

/**
 * FlyWise — Duffel Proxy — Production v3.4 (flat structure)
 * All modules in same directory — no subdirectories needed.
 */

const express      = require('express');
const helmet       = require('helmet');
const compression  = require('compression');

const logger        = require('./logger');
const config        = require('./config');
const requestId     = require('./requestId');
const requestLogger = require('./requestLogger');
const cors          = require('./cors');
const { generalLimiter } = require('./rateLimiters');
const errorHandler  = require('./errorHandler');

const healthRoutes  = require('./health');
const searchRoutes  = require('./search');
const offerRoutes   = require('./offers');
const orderRoutes   = require('./orders');

const app = express();

app.set('trust proxy', 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false,
}));
app.use(compression());
app.use(express.json({ limit: '50kb' }));
app.use(requestId);
app.use(requestLogger);
app.use(cors);
app.use(generalLimiter);

app.use('/',       healthRoutes);
app.use('/search', searchRoutes);
app.use('/offer',  offerRoutes);
app.use('/order',  orderRoutes); // POST /order, GET /order/:id, POST /order/cancel

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: `Route ${req.method} ${req.path} not found`,
    reqId: req.id,
  });
});

app.use(errorHandler);

const server = app.listen(config.PORT, () => {
  logger.info({
    port:         config.PORT,
    env:          process.env.NODE_ENV || 'development',
    cors:         config.ALLOWED_ORIGINS.join(', '),
    fetchTimeout: `${config.FETCH_TIMEOUT_MS}ms`,
    retryMax:     config.RETRY_MAX,
  }, `FlyWise Server ready on port ${config.PORT}`);
});

function shutdown(signal) {
  logger.info({ signal }, 'Shutdown signal received');
  server.close(err => {
    if (err) { logger.error({ err }, 'Error closing server'); process.exit(1); }
    logger.info('Server shut down cleanly');
    process.exit(0);
  });
  setTimeout(() => { logger.warn('Forcing exit'); process.exit(1); }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('unhandledRejection', reason => {
  logger.error({ reason: String(reason) }, 'Unhandled promise rejection');
});
process.on('uncaughtException', err => {
  logger.fatal({ err: { message: err.message, stack: err.stack } }, 'Uncaught exception');
  process.exit(1);
});

module.exports = app;
