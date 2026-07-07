// ═══════════════════════════════════════════════════════════════
// src/routes/referral.routes.js
// [REFERRAL-REBUILD] Real, server-authoritative referral endpoints —
// see src/services/referrals.js for the full rationale. Every route
// here requires a verified Supabase auth token and always acts on
// req.userId, never a client-supplied id — same IDOR-safe pattern as
// alerts.routes.js.
// ═══════════════════════════════════════════════════════════════

const rateLimit = require('../middleware/rateLimit');
const { attachUserIfPresent } = require('../middleware/auth');
const referrals = require('../services/referrals');

module.exports = (app) => {

// The caller's own shareable code, e.g. "AP-7F3A2C" (lazily created on
// first call, then stable forever after).
app.get('/referrals/my-code', attachUserIfPresent, rateLimit('referrals', 60, 60000), async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ ok: false, error: 'Nicht angemeldet' });
    const code = await referrals.getOrCreateReferralCode(req.userId);
    if (!code) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    res.json({ ok: true, code });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Called once, right after a new account is confirmed — links this new
// user to whichever referral code their browser captured from a `?ref=`
// URL param. referred_id/referred_email always come from the verified
// token, never the request body.
app.post('/referrals/link', attachUserIfPresent, rateLimit('referrals', 10, 60000), async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ ok: false, error: 'Nicht angemeldet' });
    const { referrer_code } = req.body || {};
    if (!referrer_code) return res.status(400).json({ ok: false, error: 'referrer_code erforderlich' });
    const result = await referrals.linkNewUser(req.userId, req.userEmail, referrer_code);
    res.json({ ok: true, linked: result.linked, reason: result.reason || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Checks the caller's own referrals (as either party) for any that are
// now due — real departure_date already passed — and pays out whatever
// is owed. Safe to call on every login/page-load; a no-op when nothing
// is due yet.
app.post('/referrals/check-payout', attachUserIfPresent, rateLimit('referrals', 20, 60000), async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ ok: false, error: 'Nicht angemeldet' });
    const result = await referrals.checkAndPayout(req.userId);
    res.json({ ok: true, credited_now: result.creditedNow });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// The caller's own "who did I invite" list.
app.get('/referrals/my-list', attachUserIfPresent, rateLimit('referrals', 60, 60000), async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ ok: false, error: 'Nicht angemeldet' });
    const list = await referrals.getMyReferralList(req.userId);
    res.json({ ok: true, referrals: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
};
