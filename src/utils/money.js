// ═══════════════════════════════════════════════════════════════
// src/utils/money.js
// [F7 · MONEY] أدوات تعامل مع الأموال بوحدات صغرى صحيحة (integer minor
// units) لتجنّب انحراف الفاصلة العائمة (float). القاعدة (brief §26):
// لا حساب مالي بالـfloat بدون سياسة تقريب واضحة. الوحدة الصغرى = أصغر
// وحدة في العملة (سنت لليورو/الدولار = 1/100). سياسة التقريب: "نصف
// لأعلى" (Math.round) — نفس ما كان الكود بيعمله ضمنياً
// (Math.round(x*100)/100) بس في مكان واحد موثّق.
//
// معظم العملات اللي بنتعامل معاها (EUR/USD/GBP/...) بخانتين عشريتين.
// بعض العملات بصفر (JPY) أو ثلاثة (BHD) — نتعامل معاها صح لو ظهرت،
// وإلا الافتراضي خانتين.
// ═══════════════════════════════════════════════════════════════

// عدد الخانات العشرية لكل عملة (ISO 4217 minor units). أي عملة مش
// هنا بتاخد الافتراضي 2.
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'XOF', 'XAF', 'PYG', 'RWF', 'UGX', 'VUV', 'XPF', 'BIF', 'DJF', 'GNF', 'KMF']);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

function decimalsFor(currency) {
  const c = String(currency || 'EUR').toUpperCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
}

function factorFor(currency) {
  return Math.pow(10, decimalsFor(currency));
}

// يحوّل مبلغ عشري (major units، زي 10.99) لعدد صحيح بالوحدة الصغرى
// (1099). سياسة التقريب: نصف لأعلى. يرجّع 0 لأي مدخل غير رقمي.
function toMinor(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  const factor = factorFor(currency);
  // نضيف epsilon صغير جداً قبل الـround لتفادي أخطاء تمثيل float
  // الكلاسيكية (مثلاً 1.005*100 = 100.49999999999999) اللي كانت
  // ممكن تقرّب لأقل من اللازم.
  return Math.round((n * factor) + (n >= 0 ? Number.EPSILON : -Number.EPSILON) * factor);
}

// يحوّل من الوحدة الصغرى (1099) لمبلغ عشري (10.99).
function fromMinor(minor, currency) {
  const factor = factorFor(currency);
  return Math.round(Number(minor) || 0) / factor;
}

// يقرّب مبلغ عشري لأقرب وحدة صغرى صحيحة ثم يرجّعه عشري — النقطة
// الوحيدة الموثّقة لتقريب الأموال. roundMoney(10.005,'EUR') → 10.01.
function roundMoney(amount, currency) {
  return fromMinor(toMinor(amount, currency), currency);
}

// جمع قائمة مبالغ عشرية بأمان (بالوحدة الصغرى) وإرجاع الناتج عشري.
function sumMoney(amounts, currency) {
  const total = (amounts || []).reduce((acc, a) => acc + toMinor(a, currency), 0);
  return fromMinor(total, currency);
}

module.exports = { decimalsFor, factorFor, toMinor, fromMinor, roundMoney, sumMoney };
