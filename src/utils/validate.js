// ═══════════════════════════════════════════════════════════════
// src/utils/validate.js
// [SCHEMA-VALIDATION] نظام تحقق خفيف من غير أي مكتبة خارجية (نفس
// فلسفة Zod/Joi، بس Vanilla) — بيتفحص شكل البيانات المتوقع ويرجع
// أول رسالة خطأ بالألماني بالترتيب اللي المجالات معرّفة بيه.
// ═══════════════════════════════════════════════════════════════

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateField(value, rule, fieldName) {
  // A bare string like 'string'/'number' is shorthand for { type: 'string', required: true }
  if (typeof rule === 'string') rule = { type: rule, required: true };

  if (value === undefined || value === null || value === '') {
    if (rule.required) return `${fieldName} ist erforderlich`;
    return null; // optional and absent — nothing more to check
  }

  switch (rule.type) {
    case 'string':
      if (typeof value !== 'string') return `${fieldName} muss ein Text sein`;
      if (rule.min != null && value.length < rule.min) return `${fieldName} ist zu kurz`;
      if (rule.max != null && value.length > rule.max) return `${fieldName} ist zu lang`;
      if (rule.pattern && !rule.pattern.test(value)) return `${fieldName} hat ein ungültiges Format`;
      break;
    case 'email':
      if (typeof value !== 'string' || !EMAIL_RE.test(value)) return `${fieldName} ist keine gültige E-Mail-Adresse`;
      break;
    case 'date':
      if (typeof value !== 'string' || !DATE_RE.test(value)) return `${fieldName} muss das Format JJJJ-MM-TT haben`;
      break;
    case 'number':
      if (typeof value !== 'number' || isNaN(value)) return `${fieldName} muss eine Zahl sein`;
      if (rule.min != null && value < rule.min) return `${fieldName} ist zu klein`;
      if (rule.max != null && value > rule.max) return `${fieldName} ist zu groß`;
      break;
    case 'array':
      if (!Array.isArray(value)) return `${fieldName} muss eine Liste sein`;
      if (rule.min != null && value.length < rule.min) return `${fieldName}: mindestens ${rule.min} Einträge erforderlich`;
      if (rule.max != null && value.length > rule.max) return `${fieldName}: höchstens ${rule.max} Einträge erlaubt`;
      if (rule.of) {
        for (let i = 0; i < value.length; i++) {
          const itemErr = validate(value[i], rule.of, `${fieldName}[${i}]`);
          if (itemErr) return itemErr;
        }
      }
      break;
    case 'object':
      if (typeof value !== 'object' || Array.isArray(value)) return `${fieldName} muss ein Objekt sein`;
      break;
  }
  return null;
}

// Validates `data` against `schema` (a plain object mapping field name ->
// rule). `prefix` is used internally for array-item error messages
// (e.g. "passengers[0].given_name") — never pass it manually.
function validate(data, schema, prefix) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return (prefix || 'Daten') + ' müssen ein Objekt sein';
  }
  for (const field in schema) {
    if (!Object.prototype.hasOwnProperty.call(schema, field)) continue;
    const label = prefix ? `${prefix}.${field}` : field;
    const err = validateField(data[field], schema[field], label);
    if (err) return err;
  }
  return null;
}

// [SCHEMA-VALIDATION] Reusable passenger schema — the same shape Duffel
// itself expects (given_name/family_name/born_on/email), used by every
// endpoint that accepts passenger data so a malformed passenger (missing
// name, garbage date, invalid email) is rejected with a clear message
// before ever reaching Duffel's own API.
const PASSENGER_SCHEMA = {
  given_name: { type: 'string', required: true, min: 1, max: 100 },
  family_name: { type: 'string', required: true, min: 1, max: 100 },
  born_on: { type: 'date', required: true },
  email: { type: 'email', required: false }, // not every passenger entry carries one (e.g. additional travelers reusing the contact email)
};


module.exports = { validate, validateField, PASSENGER_SCHEMA, EMAIL_RE, DATE_RE };
