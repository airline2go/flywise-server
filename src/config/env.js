// ═════════════════════════════════════════════════════════════
// src/config/env.js
// كل متغيرات البيئة اللي السيرفر بيعتمد عليها، في مكان واحد.
// أي ملف تاني محتاج يقرأ إعداد بيئة يجيبه من هنا، مش من
// process.env مباشرة — كده لو احتجنا نغيّر قيمة افتراضية أو
// نضيف تحقق إضافي، بنعدّل مكان واحد بس.
// ═════════════════════════════════════════════════════════════

module.exports = {
  PORT: process.env.PORT || 3000,

  DUFFEL_TOKEN: process.env.DUFFEL_TOKEN,
  DUFFEL_BASE: 'https://api.duffel.com',
  DUFFEL_VERSION: 'v2',

  // Signed Search Session HMAC key. Independent of user login JWTs.
  // If unset, searchGuard derives a stable key from DUFFEL_TOKEN so
  // existing deploys keep working; set this explicitly in production.
  SEARCH_SESSION_SECRET: process.env.SEARCH_SESSION_SECRET || '',

  // Cloudflare Turnstile secret (server-side). If unset, session issue
  // skips Turnstile verification (dev/test). Production should set this.
  TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY || '',

  // Background Duffel search warming (warmRoutePricesOnce). OFF unless
  // explicitly enabled — production must not search Duffel on a timer.
  DUFFEL_BACKGROUND_SEARCH_ENABLED: String(process.env.DUFFEL_BACKGROUND_SEARCH_ENABLED || '').toLowerCase() === 'true',

  PRICE_PREVIEW_DEADLINE_MS: Number(process.env.PRICE_PREVIEW_DEADLINE_MS) || 15000,

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

  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',

  GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  GOOGLE_OAUTH_REDIRECT_URI: process.env.GOOGLE_OAUTH_REDIRECT_URI,
  GSC_SITE_URL: process.env.GSC_SITE_URL,
  ADMIN_APP_URL: process.env.ADMIN_APP_URL || 'https://airpiv.com',

  REDIS_URL: process.env.REDIS_URL,

  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || 'https://airpiv.com,https://www.airpiv.com,https://flywise-app-amber.vercel.app')
    .split(',').map((s) => s.trim()).filter(Boolean),

  ADMIN_TOKEN: process.env.ADMIN_TOKEN,

  MAX_ADMIN_CREDIT_AMOUNT: Number(process.env.MAX_ADMIN_CREDIT_AMOUNT) || 1000,

  RENDER_DEPLOY_HOOK_URL: process.env.RENDER_DEPLOY_HOOK_URL,

  NEXTJS_REVALIDATE_URL: process.env.NEXTJS_REVALIDATE_URL,
  NEXTJS_REVALIDATE_SECRET: process.env.NEXTJS_REVALIDATE_SECRET,
};
