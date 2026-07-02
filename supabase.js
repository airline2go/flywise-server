// ═══════════════════════════════════════════════════════════════
// src/clients/supabase.js
// عميل Supabase — نسخة واحدة مشتركة (singleton) بيستخدمها كل
// الملفات اللي محتاجة تتكلم مع قاعدة البيانات. لو SUPABASE_URL أو
// SUPABASE_SERVICE_KEY مش موجودين، بيرجّع null (والكود اللي
// بيستخدمه لازم يتأكد من وجوده الأول — زي ما كان شغال بالظبط في
// الملف الأصلي).
// ═══════════════════════════════════════════════════════════════

const env = require('./env');

let supa = null;
if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    supa = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch (e) {
    console.error('Supabase init failed:', e.message);
  }
}

module.exports = supa;
