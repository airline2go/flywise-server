// ═══════════════════════════════════════════════════════════════
// src/middleware/auth.js
// [ADMIN] مصادقة بسيطة بـ bearer token لكل /admin/* endpoints.
// [USER-AUTH] حسابات العملاء بتتعامل معاها Supabase Auth نفسها —
// شغلة السيرفر هنا بس إنه يتحقق من التوكن اللي Supabase أصدرته
// ويربطه بمعرّف المستخدم، لأي endpoint محتاج يعرف مين اللي بيسأل.
// ═══════════════════════════════════════════════════════════════

const env = require('../config/env');
const supa = require('../clients/supabase');

function requireAdmin(req, res, next) {
  if (!env.ADMIN_TOKEN) return res.status(503).json({ ok: false, error: 'ADMIN_TOKEN nicht konfiguriert' });
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  // مقارنة زمن-ثابت (timing-safe) — مش حرجة هنا (توكن أدمن ثابت
  // واحد، مش سر لكل مستخدم)، بس timingSafeEqual مجانية عملياً.
  const a = Buffer.from(token);
  const b = Buffer.from(env.ADMIN_TOKEN);
  const valid = a.length === b.length && require('crypto').timingSafeEqual(a, b);
  if (!valid) return res.status(401).json({ ok: false, error: 'Nicht autorisiert' });
  next();
}

// middleware اختياري: لو فيه توكن Supabase صحيح، بيربط req.userId؛
// وإلا بيسيبه undefined ويكمل عادي — endpoints البحث والحجز لازم
// تشتغل للزوار المجهولين كمان، فده أبداً ميوقفش الطلب.
async function attachUserIfPresent(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token && supa) {
    try {
      const { data, error } = await supa.auth.getUser(token);
      if (!error && data && data.user) {
        req.userId = data.user.id;
        // [GUEST-LINK] الإيميل الموثّق من التوكن نفسه — أبداً منثقش
        // إيميل جاي من جسم الطلب لأي حاجة حساسة زي ربط حجز ضيف.
        req.userEmail = data.user.email || null;
      }
    } catch (e) { /* توكن تالف أو منتهي — نعامله كزائر مجهول، أبداً مانرميش خطأ */ }
  }
  next();
}

module.exports = { requireAdmin, attachUserIfPresent };
