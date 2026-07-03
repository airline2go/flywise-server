// ═══════════════════════════════════════════════════════════════
// src/config/env.js
// كل متغيرات البيئة اللي السيرفر بيعتمد عليها، في مكان واحد.
// أي ملف تاني محتاج يقرأ إعداد بيئة يجيبه من هنا، مش من
// process.env مباشرة — كده لو احتجنا نغيّر قيمة افتراضية أو
// نضيف تحقق إضافي، بنعدّل مكان واحد بس.
// ═══════════════════════════════════════════════════════════════

module.exports = {
  PORT: process.env.PORT || 3000,

  DUFFEL_TOKEN: process.env.DUFFEL_TOKEN,
  DUFFEL_BASE: 'https://api.duffel.com',
  DUFFEL_VERSION: 'v2',

  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  DUFFEL_WEBHOOK_SECRET: process.env.DUFFEL_WEBHOOK_SECRET,

  BREVO_API_KEY: process.env.BREVO_API_KEY,
  BREVO_SENDER_EMAIL: process.env.BREVO_SENDER_EMAIL || 'noreply@airpiv.com',
  BREVO_SENDER_NAME: process.env.BREVO_SENDER_NAME || 'Airpiv',
  SUPPORT_EMAIL: process.env.SUPPORT_EMAIL || 'support@airpiv.com',

  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,

  SENTRY_DSN: process.env.SENTRY_DSN,
  NODE_ENV: process.env.NODE_ENV || 'production',

  // [BLOG-AI-SEO] Optional — only used to strengthen a blog post's meta
  // description when it comes out too thin from the deterministic rules
  // in admin_routes.js. If this isn't set in Render, that step is simply
  // skipped and the deterministic (rule-based) meta description is used
  // as-is — never a hard failure, never blocks publishing.
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,

  REDIS_URL: process.env.REDIS_URL,

  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || 'https://airpiv.com,https://www.airpiv.com')
    .split(',').map((s) => s.trim()).filter(Boolean),

  ADMIN_TOKEN: process.env.ADMIN_TOKEN,
};
