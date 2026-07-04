/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║        Airpiv — Render.com Server (Duffel Proxy)         ║
 * ║              Node.js / Express — نسخة مُقسّمة             ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * [BACKEND-REFACTOR] هذا الملف كان قبل كده server.js واحد بحجم
 * ~288 كيلوبايت و5488 سطر. اتقسّم لـ 31 ملف منظّم في src/ —
 * كل ملف اتفحص syntax وبطلبات HTTP حقيقية أثناء التقسيم. السلوك
 * الفعلي (المسارات، الترتيب، المنطق) واحد بالظبط زي قبل، ده تقسيم
 * تنظيمي بحت، مش إعادة كتابة.
 *
 * الترتيب هنا حرج ومقصود:
 * 1. Sentry الأول (قبل أي require تاني، عشان يراقب كل حاجة بعده)
 * 2. حماية الكراش (uncaughtException/unhandledRejection)
 * 3. التحقق من متغيرات البيئة (فشل سريع لو حاجة أساسية ناقصة)
 * 4. الـ webhooks (لازم تتسجل قبل express.json() — محتاجة الجسم
 *    الخام raw للتحقق من التوقيع)
 * 5. express.json() + الـ middleware العام (بترتيبه الحرج الخاص)
 * 6. باقي كل الروتات
 * 7. معالج الأخطاء الموحّد (آخر حاجة قبل app.listen)
 */

// ─── [1] Sentry — أول حاجة تتحمّل ─────────────────────────
const Sentry = require('./sentry');

const express = require('express');
const app = express();
const env = require('./env');
const log = require('./log');
const supa = require('./supabase');

// ─── [2] حماية الكراش ──────────────────────────────────────
process.on('unhandledRejection', (reason, promise) => {
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

// ─── [3] التحقق من متغيرات البيئة ──────────────────────────
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
    webhook: !!env.STRIPE_WEBHOOK_SECRET,
    email: !!env.BREVO_API_KEY,
    sentry: !!env.SENTRY_DSN,
    tokenType: (env.DUFFEL_TOKEN || '').indexOf('live') !== -1 ? 'live' : 'test',
  });
})();

// ─── [4] Webhooks — لازم قبل express.json() ────────────────
require('./webhooks.routes')(app);

// ─── [5] express.json() + الـ middleware العام ─────────────
// [LONG-ARTICLE-FIX] كان 256kb — كافي لمعظم الطلبات، بس مقال طويل جدًا
// (+5000 كلمة مع روابط وHTML كتير) ممكن يقرب منه، والسيرفر وقتها كان
// هيرفض الحفظ بالكامل برسالة 413 بدل ما يحفظ. 2 ميجابايت هامش أمان
// واسع جدًا لأطول مقال ممكن يُكتب، من غير ما يفتح الباب لطلبات ضخمة
// غير منطقية (باقي الروتات الحساسة كحجم زي الدفع مش متأثرة، بتستخدم
// نفس الميدلوير العام ده بس بأجسام صغيرة جدًا أصلاً).
app.use(express.json({ limit: '2mb' }));
require('./globalMiddleware')(app);

// ─── [6] باقي كل الروتات ────────────────────────────────────
require('./health.routes')(app);
require('./search.routes')(app);
require('./booking.routes')(app);
require('./cancel.routes')(app);
require('./alerts.routes')(app);
require('./contact.routes')(app);
require('./auth.routes')(app);
require('./loyalty.routes')(app);
require('./promo.routes')(app);
require('./content.routes')(app);
require('./admin.routes')(app);

// ─── [7] معالج الأخطاء الموحّد ───────────────────────────────
if (env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}
app.use((err, req, res, next) => {
  log('error', 'unhandled_route_error', { message: err?.message, stack: err?.stack, path: req.path, reqId: req.id });
  if (res.headersSent) return next(err);
  res.status(err?.status || 500).json({
    ok: false,
    error: err?.status && err.status < 500 ? err.message : 'Ein unerwarteter Fehler ist aufgetreten.',
    requestId: req.id,
  });
});

// ─── التشغيل + الإغلاق الآمن ─────────────────────────────────
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
const server = app.listen(env.PORT, () => console.log(`✅ Airpiv Server running on port ${env.PORT}`));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
