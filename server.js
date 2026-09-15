const Sentry = require('./src/clients/sentry');
const express = require('express');
const app = express();
const env = require('./src/config/env');
const log = require('./src/utils/log');
const supa = require('./src/clients/supabase');

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  log('error', 'unhandled_rejection', { message: err.message, stack: err.stack });
  if (env.SENTRY_DSN) Sentry.captureException(err, { tags: { critical: 'unhandled_rejection' } });
});
process.on('uncaughtException', (err) => {
  log('fatal', 'uncaught_exception', { message: err.message, stack: err.stack });
  if (env.SENTRY_DSN) Sentry.captureException(err, { tags: { critical: 'uncaught_exception' } });
  try {
    if (typeof gracefulShutdown === 'function') return gracefulShutdown('uncaughtException');
  } catch (e) {}
  process.exit(1);
});

(function validateEnv() {
  const missing = [];
  if (!env.DUFFEL_TOKEN) missing.push('DUFFEL_TOKEN');
  if (missing.length) {
    log('fatal', 'Missing required environment variables', { missing });
    console.error('❌ FATAL: Missing required env vars: ' + missing.join(', '));
    process.exit(1);
  }
  if (!env.STRIPE_SECRET_KEY) log('warn', 'STRIPE_SECRET_KEY not set — payments disabled');
  if (env.STRIPE_SECRET_KEY && !env.STRIPE_WEBHOOK_SECRET) log('warn', 'STRIPE_WEBHOOK_SECRET not set — webhook fallback disabled');
  if (!env.BREVO_API_KEY) log('warn', 'BREVO_API_KEY not set — confirmation emails disabled');
  if (!env.SENTRY_DSN) log('warn', 'SENTRY_DSN not set — error tracking disabled');
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) log('warn', 'Supabase not set — using in-memory fallback');
  log('info', 'Environment validated', {
    duffel: !!env.DUFFEL_TOKEN, stripe: !!env.STRIPE_SECRET_KEY, supabase: !!supa,
    webhook: !!env.STRIPE_WEBHOOK_SECRET, email: !!env.BREVO_API_KEY,
    sentry: !!env.SENTRY_DSN,
    tokenType: (env.DUFFEL_TOKEN || '').indexOf('live') !== -1 ? 'live' : 'test',
  });
})();

require('./src/routes/webhooks.routes')(app);
require('./src/routes/seo.routes')(app);
app.use(express.json({ limit: '2mb' }));
require('./src/middleware/globalMiddleware')(app);

require('./src/routes/health.routes')(app);
env.DUFFEL_BACKGROUND_SEARCH_ENABLED = false;
require('./src/middleware/liveRoutePrice')(app);
require('./src/middleware/routePriceVisitRefresh')(app);
require('./src/middleware/blockAutomatedDuffelProbes')(app);
require('./src/routes/search.routes')(app);
require('./src/routes/booking.routes')(app);
require('./src/routes/cancel.routes')(app);
require('./src/routes/flight-change.routes')(app);
require('./src/routes/alerts.routes')(app);
require('./src/routes/contact.routes')(app);
require('./src/routes/auth.routes')(app);
require('./src/routes/loyalty.routes')(app);
require('./src/routes/referral.routes')(app);
require('./src/routes/promo.routes')(app);
require('./src/routes/content.routes')(app);
require('./src/routes/reviews.routes')(app);
require('./src/routes/sitemap.routes')(app);
require('./src/routes/tracking.routes')(app);
require('./src/routes/admin.routes')(app);
require('./src/routes/admin-duffel.routes')(app);
require('./src/routes/route-airline-backfill.routes')(app);
require('./src/routes/admin-staff.routes')(app);
require('./src/routes/admin-customers.routes')(app);
require('./src/routes/admin-geo.routes')(app);
require('./src/routes/admin-airlines.routes')(app);
require('./src/routes/admin-fare-rules.routes')(app);
require('./src/routes/admin-seo.routes')(app);
require('./src/routes/admin-gsc.routes')(app);
require('./src/routes/admin-finance.routes')(app);

require('./src/services/routeTraffic');
require('./src/services/routeScore');
require('./src/services/routeIntelligenceRefresh');
require('./src/services/routePriceHistoryRefresh');
require('./src/services/socialAutoGenerate');
require('./src/services/finance/financeCron').start();

if (env.SENTRY_DSN) Sentry.setupExpressErrorHandler(app);
app.use((err, req, res, next) => {
  log('error', 'unhandled_route_error', { message: err?.message, stack: err?.stack, path: req.path, reqId: req.id });
  if (res.headersSent) return next(err);
  res.status(err?.status || 500).json({
    ok: false,
    error: err?.status && err.status < 500 ? err.message : 'Ein unerwarteter Fehler ist aufgetreten.',
    requestId: req.id,
  });
});

function gracefulShutdown(signal) {
  log('info', 'shutdown_initiated', { signal });
  server.close(() => {
    log('info', 'shutdown_complete', {});
    process.exit(0);
  });
  setTimeout(() => {
    log('warn', 'shutdown_forced', {});
    process.exit(1);
  }, 25000).unref();
}
let server;
if (require.main === module) {
  server = app.listen(env.PORT, () => console.log(`✅ Airpiv Server running on port ${env.PORT}`));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}
module.exports = app;
