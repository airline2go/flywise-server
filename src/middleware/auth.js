// ═══════════════════════════════════════════════════════════════
// src/middleware/auth.js
// [ADMIN] مصادقة كل /admin/* endpoints. تدعم مسارين معاً:
//   1) ADMIN_TOKEN المشترك القديم (نفس السلوك السابق تماماً، بدون
//      أي تغيير — أي كود موجود بيستخدم requireAdmin بيفضل شغال
//      زي ما هو).
//   2) جلسات موظفين حقيقية (admin_sessions)، بعد نظام الهوية
//      الجديد — كل جلسة عندها دور (admin أو staff).
// requireFullAdmin إضافة جديدة بس — بوابة أشد بس للحاجات الحساسة
// فعلاً (هوامش الربح، إضافة رصيد، إدارة الموظفين).
// [USER-AUTH] حسابات العملاء بتتعامل معاها Supabase Auth نفسها —
// شغلة السيرفر هنا بس إنه يتحقق من التوكن اللي Supabase أصدرته
// ويربطه بمعرّف المستخدم، لأي endpoint محتاج يعرف مين اللي بيسأل.
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const env = require('../config/env');
const supa = require('../clients/supabase');
const { resolveSession } = require('../services/adminAuth');

async function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';

  // المسار القديم أولاً — نفس المقارنة الزمن-ثابتة بالظبط، بدون أي
  // تغيير في السلوك لصاحب الـ ADMIN_TOKEN الأصلي.
  if (env.ADMIN_TOKEN && token) {
    const a = Buffer.from(token);
    const b = Buffer.from(env.ADMIN_TOKEN);
    const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (valid) {
      req.adminRole = 'admin';
      req.adminUserId = null;
      return next();
    }
  }

  // مش الـ ADMIN_TOKEN القديم — نجرب كـ جلسة موظف حقيقية.
  if (token) {
    try {
      const session = await resolveSession(token);
      if (session) {
        req.adminRole = session.role;
        req.adminUserId = session.adminUserId;
        return next();
      }
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ولا مسار نجح — نفس رسالة التشخيص الأصلية بالظبط لو ADMIN_TOKEN
  // مش معرّف إطلاقاً (يعني السيرفر نفسه مش مجهّز لمصادقة الأدمن).
  if (!env.ADMIN_TOKEN) return res.status(503).json({ ok: false, error: 'ADMIN_TOKEN nicht konfiguriert' });
  return res.status(401).json({ ok: false, error: 'Nicht autorisiert' });
}

// [FULL-ADMIN-ONLY] بوابة إضافية فوق requireAdmin — بس لصاحب الدور
// 'admin' (المالك، أو ADMIN_TOKEN القديم). موظف role='staff' بيوصل
// لـ requireAdmin عادي بس بيتوقف هنا بـ 403.
function requireFullAdmin(req, res, next) {
  requireAdmin(req, res, () => {
    if (req.adminRole !== 'admin') return res.status(403).json({ ok: false, error: 'Nur für Administratoren' });
    next();
  });
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

module.exports = { requireAdmin, requireFullAdmin, attachUserIfPresent };
