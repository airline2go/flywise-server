// ═══════════════════════════════════════════════════════════════
// src/routes/admin-customers.routes.js
// [CREDIT] إضافة رصيد لأي عميل من لوحة الأدمن — requireFullAdmin
// بس (نفس مستوى حماية هوامش الربح). كل عملية بتتسجل في مكانين:
// loyalty_transactions (السجل العام لكل حركة رصيد) و
// admin_credit_log (السجل المخصص لعمليات الأدمن نفسها).
// ═══════════════════════════════════════════════════════════════

const env = require('../config/env');
const log = require('../utils/log');
const supa = require('../clients/supabase');
const rateLimit = require('../middleware/rateLimit');
const { requireFullAdmin } = require('../middleware/auth');
const { logAdminActivity } = require('../services/adminAuth');
const { getOrCreateLoyaltyAccount } = require('../services/loyalty');

module.exports = (app) => {

app.post('/admin/customers/credit', rateLimit('admin', 120, 60000), requireFullAdmin, async (req, res) => {
  try {
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { user_id, amount, reason } = req.body || {};
    if (!user_id) return res.status(400).json({ ok: false, error: 'user_id ist erforderlich' });
    const amt = Math.round((Number(amount) || 0) * 100) / 100;
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ ok: false, error: 'amount muss größer als 0 sein' });
    if (amt > env.MAX_ADMIN_CREDIT_AMOUNT) {
      return res.status(400).json({ ok: false, error: `amount darf ${env.MAX_ADMIN_CREDIT_AMOUNT} nicht überschreiten` });
    }

    // [SANITY-CHECK] الأدمن بيختار user_id من عميل لقاه بالبحث — نتأكد
    // إنه فعلاً موجود (له حجز واحد ع الأقل) قبل ما ننشئله حساب ولاء.
    const { data: existingBooking } = await supa.from('bookings').select('id').eq('user_id', user_id).limit(1).maybeSingle();
    if (!existingBooking) return res.status(404).json({ ok: false, error: 'Kein Kunde mit dieser user_id gefunden' });

    const account = await getOrCreateLoyaltyAccount('user', user_id);
    if (!account) return res.status(500).json({ ok: false, error: 'Loyalty-Konto konnte nicht geladen werden' });

    const oldBalance = Number(account.credit) || 0;
    const newBalance = Math.round((oldBalance + amt) * 100) / 100;

    const { error: updateErr } = await supa.from('loyalty_accounts').update({ credit: newBalance }).eq('user_id', user_id);
    if (updateErr) throw new Error(updateErr.message);

    const { error: ledgerErr } = await supa.from('loyalty_transactions').insert({
      user_id,
      type: 'admin_credit',
      amount: amt,
      balance_after: newBalance,
      created_by_admin_id: req.adminUserId || null,
      note: reason || null,
    });
    if (ledgerErr) log('warn', 'loyalty_transactions_insert_failed', { error: ledgerErr.message });

    const { error: creditLogErr } = await supa.from('admin_credit_log').insert({
      admin_user_id: req.adminUserId || null,
      target_user_id: user_id,
      amount: amt,
      old_balance: oldBalance,
      new_balance: newBalance,
      reason: reason || null,
    });
    if (creditLogErr) log('warn', 'admin_credit_log_insert_failed', { error: creditLogErr.message });

    logAdminActivity(req.adminUserId, 'customer_credit_added', 'user', user_id, { amount: amt, reason: reason || null });
    log('info', 'admin_credit_added', { adminUserId: req.adminUserId, targetUserId: user_id, amount: amt });

    res.json({ ok: true, old_balance: oldBalance, new_balance: newBalance });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

};
