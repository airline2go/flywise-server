// ═════════════════════════════════════════════════════════════
// src/middleware/globalMiddleware.js
// [ترتيب حرج جداً] كل الـ middleware العام اللي بيشتغل على كل
// طلب، بنفس الترتيب بالظبط اللي كان في الملف الأصلي — الترتيب ده
// مهم فعلياً (مثلاً: فحص الصيانة لازم يجري الأول عشان يقدر يوقف
// أي حاجة تانية بدري، وتعقيم الجسم لازم يجري قبل أي كود بيقرأ
// req.body). دالة واحدة بتتنده مرة واحدة من server.js.
// ═════════════════════════════════════════════════════════════

const zlib = require('zlib');
const env = require('../config/env');
const log = require('../utils/log');
const sanitizeValue = require('../utils/sanitize');
const { getAdminConfig } = require('../services/adminConfig');

function applyGlobalMiddleware(app) {
  app.use((req, res, next) => {
    req.id = require('crypto').randomBytes(6).toString('hex');
    res.setHeader('X-Request-Id', req.id);
    next();
  });

  app.use(async (req, res, next) => {
    if (req.path.startsWith('/admin/') || req.path === '/maintenance-status' || req.path === '/health' || req.path === '/readiness' || req.path === '/' || req.path === '/status') {
      return next();
    }
    try {
      const maint = await getAdminConfig('maintenance_mode', { enabled: false, message: '' });
      if (maint && maint.enabled) {
        return res.status(503).json({
          ok: false,
          maintenance: true,
          error: maint.message || 'Airpiv ist vorübergehend nicht verfügbar. Bitte versuche es später erneut.',
        });
      }
    } catch (e) {
      log('warn', 'maintenance_check_failed', { error: e.message });
    }
    next();
  });

  app.use((req, res, next) => {
    const accepts = (req.headers['accept-encoding'] || '');
    if (accepts.indexOf('gzip') === -1) return next();
    const origJson = res.json.bind(res);
    res.json = (body) => {
      try {
        const str = JSON.stringify(body);
        if (str.length < 1024) { res.setHeader('Content-Type', 'application/json'); return res.send(str); }
        const buf = zlib.gzipSync(str);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Vary', 'Accept-Encoding');
        return res.end(buf);
      } catch (e) {
        return origJson(body);
      }
    };
    next();
  });

  app.use((req, res, next) => {
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Robots-Tag', 'noindex, nofollow');
    res.header('X-Frame-Options', 'DENY');
    res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.header('X-XSS-Protection', '1; mode=block');
    res.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    res.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
    res.header('X-DNS-Prefetch-Control', 'off');
    res.header('Cross-Origin-Opener-Policy', 'same-origin');
    res.header('Cross-Origin-Resource-Policy', 'cross-origin');
    res.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    res.removeHeader && res.removeHeader('X-Powered-By');
    if (/^\/(confirm-payment|create-checkout-session|order|cancel|booking-status)/.test(req.path)) {
      res.header('Cache-Control', 'no-store');
    }
    next();
  });

  const SLOW_REQUEST_THRESHOLD_MS = 2000;
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      log('req', req.method + ' ' + req.path, { status: res.statusCode, ms, reqId: req.id });
      if (ms > SLOW_REQUEST_THRESHOLD_MS) {
        log('warn', 'slow_request', { method: req.method, path: req.path, ms, reqId: req.id });
      }
    });
    next();
  });

  app.use((req, res, next) => {
    if (req.body && typeof req.body === 'object') {
      try { req.body = sanitizeValue(req.body, 0); } catch (e) { /* تنظيف أفضل-جهد — أبداً مايوقفش الطلب */ }
    }
    next();
  });

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const normalizedOrigin = origin ? origin.replace(/\/+$/, '') : null;
    if (normalizedOrigin && env.ALLOWED_ORIGINS.includes(normalizedOrigin)) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Vary', 'Origin');
    } else if (normalizedOrigin) {
      log('warn', 'cors_origin_rejected', { origin, allowed: env.ALLOWED_ORIGINS });
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Search-Session');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

module.exports = applyGlobalMiddleware;
