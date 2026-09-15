const env = require('../config/env');

// Production policy: no autonomous/admin route probing of Duffel. Real user
// searches and user-authorized transactional calls remain available; these
// maintenance endpoints are intentionally disabled so they can never create
// outbound offer-request traffic outside a real visitor flow.
const BLOCKED_PATHS = new Set([
  '/admin/route-pages/health-check-batch',
  '/admin/route-pages/backfill-airlines-batch',
  '/admin/route-pages/backfill-locations',
]);

module.exports = (app) => {
  app.use((req, res, next) => {
    if (env.NODE_ENV === 'production' && BLOCKED_PATHS.has(req.path)) {
      return res.status(403).json({
        ok: false,
        error: 'Automated Duffel-Probes sind in Produktion deaktiviert.',
      });
    }
    return next();
  });
};

module.exports.BLOCKED_PATHS = BLOCKED_PATHS;
