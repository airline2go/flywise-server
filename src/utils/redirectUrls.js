// ═══════════════════════════════════════════════════════════════
// src/utils/redirectUrls.js
// [SECURITY · OPEN-REDIRECT] بناء روابط success_url / cancel_url
// الخاصة بـ Stripe Checkout بشكل آمن. الفرونت إند بيبعت الروابط دي
// في جسم الطلب، ومن غير تحقق أي حد يقدر يبعت دومين خارجي (open
// redirect) أو javascript:/data: أو رابط بروتوكول-نسبي — فالسيرفر
// لازم يتحقق منها بنفسه.
//
// القاعدة: نقبل رابط العميل فقط لو أصله (origin) ضمن
// env.ALLOWED_ORIGINS (نفس whitelist الخاص بـ CORS). أي رابط تاني —
// خارجي، مشوّه، أو ببروتوكول غير http/https — بيتم تجاهله والرجوع
// لأساس الموقع الرسمي (أول عنصر في ALLOWED_ORIGINS) بدل ما نثق
// فيه. مفيش قيمة example.com افتراضية بعد كده.
// ═══════════════════════════════════════════════════════════════

const env = require('../config/env');

// يرجّع URL object لو الرابط سليم وببروتوكول http/https فقط، وإلا null.
// أي بروتوكول تاني (javascript:, data:, file:, ...) بيترفض هنا تلقائياً،
// وكمان الروابط المشوّهة والروابط البروتوكول-نسبية (//evil.com) اللي
// new URL() بيرفضها من غير base.
function safeParse(url) {
  if (!url || typeof url !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  return parsed;
}

function allowedOrigins() {
  return Array.isArray(env.ALLOWED_ORIGINS) ? env.ALLOWED_ORIGINS : [];
}

// الأساس الرسمي اللي بنرجع له لو رابط العميل مرفوض/ناقص.
function defaultBase() {
  const list = allowedOrigins();
  return (list && list[0]) || 'https://airpiv.com';
}

// يرجّع رابط إعادة توجيه آمن:
//  - لو رابط العميل أصله ضمن whitelist → نستخدمه كما هو (بالمسار
//    والاستعلام والـ hash، بدون origin مزوّر).
//  - غير كده → أساس الموقع الرسمي + fallbackPath.
function sanitizeRedirectUrl(clientUrl, fallbackPath) {
  const parsed = safeParse(clientUrl);
  if (parsed && allowedOrigins().includes(parsed.origin)) {
    return parsed.origin + parsed.pathname + parsed.search + parsed.hash;
  }
  const base = defaultBase();
  let path = fallbackPath == null ? '/' : String(fallbackPath);
  if (!path.startsWith('/')) path = '/' + path;
  return base + path;
}

// يضيف باراميتر استعلام (زي session_id={CHECKOUT_SESSION_ID}) بشكل
// صحيح سواء الرابط فيه ? قبل كده أو لأ. القيمة بتتساب زي ما هي عشان
// placeholder بتاع Stripe ({CHECKOUT_SESSION_ID}) يفضل حرفياً.
function appendQueryParam(url, key, value) {
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + key + '=' + value;
}

// Helper عالي المستوى لـ Stripe Checkout: يرجّع { success_url, cancel_url }
// جاهزين وآمنين. opts: { successPath, cancelPath, successParam }.
function buildCheckoutRedirects(clientSuccessUrl, clientCancelUrl, opts) {
  opts = opts || {};
  const successFallback = opts.successPath || '/booking-confirmation';
  const cancelFallback = opts.cancelPath || '/';
  const paramKey = opts.successParam || 'session_id';
  const successBase = sanitizeRedirectUrl(clientSuccessUrl, successFallback);
  const cancelUrl = sanitizeRedirectUrl(clientCancelUrl, cancelFallback);
  const successUrl = appendQueryParam(successBase, paramKey, '{CHECKOUT_SESSION_ID}');
  return { success_url: successUrl, cancel_url: cancelUrl };
}

module.exports = {
  sanitizeRedirectUrl,
  appendQueryParam,
  buildCheckoutRedirects,
  _safeParse: safeParse,
};
