// ═══════════════════════════════════════════════════════════════
// src/routes/loyalty.routes.js
// /loyalty/redeem (تحويل نقاط لرصيد، من طرف السيرفر بالكامل)،
// /loyalty/config (قراءة عامة لأرقام الولاء القابلة للتعديل).
// ═══════════════════════════════════════════════════════════════

const log = require('../utils/log');
const supa = require('../clients/supabase');
const rateLimit = require('../middleware/rateLimit');
const { attachUserIfPresent } = require('../middleware/auth');
const { getLoyaltyConfig, getOrCreateLoyaltyAccount, logLoyaltyTransaction } = require('../services/loyalty');

module.exports = (app) => {

app.post('/loyalty/redeem', attachUserIfPresent, rateLimit('loyalty-redeem', 20, 60000), async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ ok: false, error: 'Nicht angemeldet' });
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });

    const pointsToRedeem = Math.floor(Number(req.body && req.body.points));
    if (!pointsToRedeem || pointsToRedeem <= 0) {
      return res.status(400).json({ ok: false, error: 'Ungültige Punktezahl' });
    }

    const cfg = await getLoyaltyConfig();
    const pointsPerEuro = Number(cfg.pointsPerEuroRedeem) || 400;
    if (pointsToRedeem % pointsPerEuro !== 0) {
      return res.status(400).json({ ok: false, error: 'Punktezahl muss ein Vielfaches von ' + pointsPerEuro + ' sein' });
    }

    const account = await getOrCreateLoyaltyAccount('user', req.userId);
    if (!account) return res.status(500).json({ ok: false, error: 'Konto nicht gefunden' });

    const currentPoints = Number(account.points) || 0;
    if (pointsToRedeem > currentPoints) {
      return res.status(400).json({ ok: false, error: 'Nicht genug Punkte', available_points: currentPoints });
    }

    const euros = Math.round((pointsToRedeem / pointsPerEuro) * 100) / 100;
    const newPoints = currentPoints - pointsToRedeem;
    const newCredit = Math.round(((Number(account.credit) || 0) + euros) * 100) / 100;

    const { data: updated, error } = await supa.from('loyalty_accounts')
      .update({ points: newPoints, credit: newCredit })
      .eq('user_id', req.userId)
      .select()
      .maybeSingle();
    if (error) throw new Error(error.message);

    logLoyaltyTransaction('user', req.userId, 'reward', euros, newCredit, `${pointsToRedeem} Punkte eingelöst`);
    log('info', 'loyalty_points_redeemed', { userId: req.userId, points: pointsToRedeem, euros, newPoints, newCredit });
    res.json({
      ok: true,
      redeemed_points: pointsToRedeem,
      redeemed_euros: euros,
      loyalty: {
        credit: updated.credit,
        points: updated.points,
        lifetime_points: updated.lifetime_points != null ? updated.lifetime_points : updated.points,
        tier: updated.tier,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/loyalty/config', rateLimit('loyalty', 60, 60000), async (req, res) => {
  try {
    const cfg = await getLoyaltyConfig();
    res.json({ ok: true, config: cfg });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
};
