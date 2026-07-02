// ═══════════════════════════════════════════════════════════════
// src/utils/log.js
// [#7] تسجيل موحّد لكل السيرفر — نفس السلوك بالظبط زي الملف
// الأصلي: يطبع JSON في الكونسول، وبيخزّن أخطاء/تحذيرات في جدول
// error_logs في قاعدة البيانات (fire-and-forget، أبداً ميوقفش
// تنفيذ الكود اللي بينده عليه).
// ═══════════════════════════════════════════════════════════════

const supa = require('../clients/supabase');

function log(level, msg, meta) {
  try {
    console.log(JSON.stringify(Object.assign({ t: new Date().toISOString(), level, msg }, meta || {})));
  } catch (e) {
    console.log(level, msg);
  }
  // [ERROR-LOGS] نخزّن أخطاء/تحذيرات في قاعدة البيانات عشان تفضل
  // متاحة بعد ما لوجز Render تتمسح، وتظهر في لوحة الأدمن.
  if ((level === 'error' || level === 'fatal' || level === 'warn') && supa) {
    let source = 'server';
    const haystack = (msg + ' ' + JSON.stringify(meta || {})).toLowerCase();
    if (haystack.includes('stripe')) source = 'stripe';
    else if (haystack.includes('duffel')) source = 'duffel';
    else if (haystack.includes('email') || haystack.includes('brevo')) source = 'email';
    else if (haystack.includes('booking')) source = 'booking';
    supa.from('error_logs').insert({ level, message: msg, meta: meta || null, source })
      .then(({ error }) => { if (error) console.error('[error_logs insert failed]', error.message); });
  }
}

module.exports = log;
