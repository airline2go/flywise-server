// ═══════════════════════════════════════════════════════════════
// src/routes/health.routes.js
// /, /status, /health (فحص شامل حقيقي)، /maintenance-status
// (عام، بيفحصه أي زائر)، و/admin/maintenance-mode (محمي بالأدمن).
// ═══════════════════════════════════════════════════════════════

const env = require('../config/env');
const log = require('../utils/log');
const supa = require('../clients/supabase');
const redis = require('../clients/redis');
const rateLimit = require('../middleware/rateLimit');
const { requireAdmin } = require('../middleware/auth');
const duffel = require('../services/duffel');
const { getAdminConfig, setAdminConfig } = require('../services/adminConfig');

async function checkWithTimeout(fn, ms) {
  return Promise.race([
    fn().then((v) => ({ ok: true, ...v })).catch((e) => ({ ok: false, error: e.message })),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'timeout' }), ms)),
  ]);
}

async function getMaintenanceConfig() {
  return getAdminConfig('maintenance_mode', { enabled: false, message: '' });
}

module.exports = (app) => {
  app.get('/', (req, res) => {
    res.json({
      ok: true,
      service: 'Airpiv Server',
      version: '3.0',
      tokenConfigured: !!env.DUFFEL_TOKEN,
      stripeConfigured: !!env.STRIPE_SECRET_KEY,
    });
  });

  app.get('/status', (req, res) => {
    res.json({
      ok: true,
      service: 'Airpiv Server',
      tokenConfigured: !!env.DUFFEL_TOKEN,
      stripeConfigured: !!env.STRIPE_SECRET_KEY,
    });
  });

  app.get('/health', rateLimit('health', 30, 60000), async (req, res) => {
    const [redisCheck, supaCheck, stripeCheck, duffelCheck] = await Promise.all([
      checkWithTimeout(async () => {
        if (!redis || redis.status !== 'ready') return { ok: false, error: 'not connected' };
        await redis.ping();
        return {};
      }, 3000),
      checkWithTimeout(async () => {
        if (!supa) return { ok: false, error: 'not configured' };
        const { error } = await supa.from('admin_config').select('key').limit(1);
        if (error) throw new Error(error.message);
        return {};
      }, 3000),
      checkWithTimeout(async () => {
        if (!env.STRIPE_SECRET_KEY) return { ok: false, error: 'not configured' };
        return {};
      }, 1000),
      checkWithTimeout(async () => {
        if (!env.DUFFEL_TOKEN) return { ok: false, error: 'not configured' };
        return {};
      }, 1000),
    ]);
    const checks = { redis: redisCheck, supabase: supaCheck, stripe: stripeCheck, duffel: duffelCheck };
    const allOk = Object.values(checks).every((c) => c.ok);
    res.status(allOk ? 200 : 503).json({
      ok: allOk,
      timestamp: new Date().toISOString(),
      checks,
      duffelCircuit: duffel.getDuffelCircuitStatus(),
    });
  });

  app.get('/maintenance-status', async (req, res) => {
    try {
      const cfg = await getMaintenanceConfig();
      res.json({ ok: true, enabled: !!cfg.enabled, message: cfg.message || '' });
    } catch (err) {
      res.json({ ok: true, enabled: false, message: '' });
    }
  });

  app.get('/admin/maintenance-mode', requireAdmin, async (req, res) => {
    try {
      const cfg = await getMaintenanceConfig();
      res.json({ ok: true, enabled: !!cfg.enabled, message: cfg.message || '' });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
  app.post('/admin/maintenance-mode', requireAdmin, async (req, res) => {
    try {
      const enabled = !!req.body.enabled;
      const message = typeof req.body.message === 'string' ? req.body.message.slice(0, 500) : '';
      await setAdminConfig('maintenance_mode', { enabled, message });
      log('info', 'maintenance_mode_changed', { enabled });
      res.json({ ok: true, enabled, message });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
};
