// ═══════════════════════════════════════════════════════════════
// src/clients/sentry.js
// [#8] Sentry error tracking. لازم يتحمّل قبل أي حاجة تانية عشان
// يقدر يراقب كل الموديولز اللي بتتحمّل بعده — لو SENTRY_DSN مش
// موجود، init() بيتجاهل والـ Sentry.* calls في باقي الكود بتبقى
// no-op آمنة تماماً.
// ═══════════════════════════════════════════════════════════════

const Sentry = require('@sentry/node');
const env = require('../config/env');

if (env.SENTRY_DSN) {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: 0.2, // 20% من الطلبات بتتراقب للأداء؛ الأخطاء دايماً 100%
  });
}

module.exports = Sentry;
