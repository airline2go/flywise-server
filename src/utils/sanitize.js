// ═══════════════════════════════════════════════════════════════
// src/utils/sanitize.js
// [#13] تعقيم متكرر لأي جسم طلب JSON — بيشيل control characters
// والأصفار الفارغة، بيحدد طول النصوص، وعنده حماية من proto-
// pollution (منع تعديل __proto__/constructor/prototype).
// ═══════════════════════════════════════════════════════════════

// [LONG-CONTENT-FIX] Per-string hard cap. Was 2000, which silently truncated
// any legitimately long field — most visibly blog article `content` (a
// published post was chopped mid-word at ~2000 chars before the handler ever
// saw it), but also intro_text / FAQ answers / terminal info etc. Raised to
// 100000 so real long-form content survives; the whole request body is still
// bounded by express.json({ limit: '2mb' }) in server.js, and the control-char
// stripping + proto-pollution guards below are unchanged.
const MAX_STRING_LENGTH = 100000;

function sanitizeValue(v, depth) {
  if (depth > 6) return v;
  if (typeof v === 'string') {
    return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, MAX_STRING_LENGTH);
  }
  if (Array.isArray(v)) {
    if (v.length > 100) v = v.slice(0, 100);
    return v.map((x) => sanitizeValue(x, depth + 1));
  }
  if (v && typeof v === 'object') {
    const out = {};
    let n = 0;
    for (const k in v) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      if (n++ > 100) break;
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = sanitizeValue(v[k], depth + 1);
    }
    return out;
  }
  return v;
}

module.exports = sanitizeValue;
