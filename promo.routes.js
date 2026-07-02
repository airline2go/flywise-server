// ═══════════════════════════════════════════════════════════════
// src/routes/promo.routes.js
// معاينة كود خصم (بس معاينة — الاحتساب الفعلي دايماً من
// computeAuthoritativePricing وقت الدفع الحقيقي).
// ═══════════════════════════════════════════════════════════════

const rateLimit = require('./rateLimit');
const { lookupPromoCode } = require('./booking');

module.exports = (app) => {

app.get('/promo/check', rateLimit('promo', 30, 60000), async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).json({ ok: false, error: 'code erforderlich' });
    const lookup = await lookupPromoCode(code);
    if (!lookup || !lookup.valid) {
      return res.json({ ok: true, valid: false, reason: (lookup && lookup.reason) || 'invalid' });
    }
    res.json({ ok: true, valid: true, code: lookup.row.code, type: lookup.row.type, value: Number(lookup.row.value) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
};
