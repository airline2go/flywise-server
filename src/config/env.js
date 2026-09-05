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

  // [P0.8 · DEADLINE] Overall wall-clock cap (ms) for the upstream Duffel
  // work inside a /price-preview pricing computation — the interactive path
  // the customer waits on live. When exceeded, the in-flight offer/seat-map
  // fetches are aborted, any remaining retry is stopped, and the endpoint
  // returns a controlled UPSTREAM_TIMEOUT (504) instead of hanging up to the
  // ~40s double-timeout measured in the P0.2 baseline. Chosen from that
  // baseline: Duffel offers p75≈9.4s / seat_maps p75≈9.9s, so 15s lets the
  // large majority of genuinely-successful calls finish while cutting the
  // 20s/40s timeout tail. Booking/checkout paths do NOT pass a deadline, so
  // their behaviour is unchanged. Tunable from Render without a code change.
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

  // [BLOG-AI-SEO] Optional — only used to strengthen a blog post's meta
  // description when it comes out too thin from the deterministic rules
  // in admin_routes.js. If this isn't set in Render, that step is simply
  // skipped and the deterministic (rule-based) meta description is used
  // as-is — never a hard failure, never blocks publishing.
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,

  // [SEO-AI-OPTIMIZE] The Claude model used by the SEO route-optimization
  // endpoint (POST /admin/seo/optimize). Configurable so the model can be
  // switched from Render's env without a code change or a frontend rebuild.
  // Defaults to the same model the rest of the backend's AI calls use.
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',

  // [GSC-OAUTH] Google Search Console connection (OAuth 2.0 — no service-account
  // key needed). All server-side only. GOOGLE_OAUTH_REDIRECT_URI must exactly
  // match the redirect URI registered on the Google OAuth client, and point at
  // this server's callback, e.g. https://api.airpiv.com/admin/seo/gsc/callback.
  // GSC_SITE_URL is the Search Console property: 'sc-domain:airpiv.com' for a
  // Domain property, or 'https://airpiv.com/' for a URL-prefix property.
  // ADMIN_APP_URL is the admin frontend base the callback redirects back to.
  GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  GOOGLE_OAUTH_REDIRECT_URI: process.env.GOOGLE_OAUTH_REDIRECT_URI,
  GSC_SITE_URL: process.env.GSC_SITE_URL,
  ADMIN_APP_URL: process.env.ADMIN_APP_URL || 'https://airpiv.com',

  REDIS_URL: process.env.REDIS_URL,

  // [NEXTJS-MIGRATION] flywise-app-amber.vercel.app is the new Next.js
  // frontend (Phase 0 of the migration to Next.js — see project history)
  // — added to the default allowlist so it doesn't need a matching env var
  // change on Render to fetch from the public content endpoints.
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || 'https://airpiv.com,https://www.airpiv.com,https://flywise-app-amber.vercel.app')
    .split(',').map((s) => s.trim()).filter(Boolean),

  ADMIN_TOKEN: process.env.ADMIN_TOKEN,

  // [ADMIN-CREDIT-CAP] أعلى مبلغ يقدر الأدمن يضيفه بضغطة وحدة على أي
  // حساب — حماية من غلطة كتابة رقم زايد صفر أو نقر مرتين بسرعة.
  MAX_ADMIN_CREDIT_AMOUNT: Number(process.env.MAX_ADMIN_CREDIT_AMOUNT) || 1000,

  // [AUTO-REBUILD] Optional — flywise-app's Render "Deploy Hook" URL. When
  // set, publishing/editing/deleting a city, country, airport, route, or
  // blog post fires this hook so the frontend's SSG build picks up the
  // change without waiting for the next code push. If unset, this feature
  // is simply skipped — never a hard failure, never blocks the admin action.
  RENDER_DEPLOY_HOOK_URL: process.env.RENDER_DEPLOY_HOOK_URL,

  // [NEXTJS-REVALIDATE] Optional — the Next.js frontend's base URL and a
  // shared secret, used to call its `/api/revalidate` route on-demand
  // whenever a route page/blog post is published/edited/deleted (Phase 2
  // of the Next.js migration — see the migration plan). This is additive
  // to RENDER_DEPLOY_HOOK_URL above, not a replacement: the old static
  // site still needs its own rebuild trigger until the full domain
  // cutover happens. If either var is unset, this feature is simply
  // skipped — never a hard failure, never blocks the admin action.
  NEXTJS_REVALIDATE_URL: process.env.NEXTJS_REVALIDATE_URL,
  NEXTJS_REVALIDATE_SECRET: process.env.NEXTJS_REVALIDATE_SECRET,
};
