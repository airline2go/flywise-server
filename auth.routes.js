// ═══════════════════════════════════════════════════════════════
// src/routes/auth.routes.js
// /auth/me (بروفايل + رصيد الولاء)، /auth/link-guest-bookings (ربط
// حجوزات الضيف بالحساب بعد تسجيل الدخول)، /my-bookings (حجوزات
// المستخدم — من السيرفر بمفتاح الخدمة، مش من المتصفح مباشرة).
// ═══════════════════════════════════════════════════════════════

const log = require('./log');
const supa = require('./supabase');
const rateLimit = require('./rateLimit');
const { attachUserIfPresent } = require('./auth');
const { getOrCreateLoyaltyAccount } = require('./loyalty');

module.exports = (app) => {

app.get('/auth/me', attachUserIfPresent, async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ ok: false, error: 'Nicht angemeldet' });
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const account = await getOrCreateLoyaltyAccount('user', req.userId);
    // [TIER-PROGRESS-FIX] lifetime_points falls back to points for accounts
    // created before that column existed, so this never returns undefined.
    res.json({ ok: true, userId: req.userId, loyalty: account ? {
      credit: account.credit,
      points: account.points,
      lifetime_points: account.lifetime_points != null ? account.lifetime_points : account.points,
      tier: account.tier,
    } : null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/auth/link-guest-bookings', attachUserIfPresent, rateLimit('link-bookings', 10, 60000), async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ ok: false, error: 'Nicht angemeldet' });
    if (!req.userEmail) return res.json({ ok: true, linked: [] }); // no verified email on the account — nothing to match
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });

    const { data, error } = await supa.rpc('link_guest_bookings_to_user', {
      p_user_id: req.userId,
      p_email: req.userEmail,
    });
    if (error) throw new Error(error.message);

    const linked = (data || []).map((b) => ({
      bookingReference: b.booking_reference,
      routeLabel: b.route_label,
      createdAt: b.created_at,
      customerPaid: Number(b.customer_paid) || 0,
      currency: b.currency,
    }));
    if (linked.length) log('info', 'guest_bookings_linked', { userId: req.userId, count: linked.length });
    res.json({ ok: true, linked });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── GET /my-bookings ─────────────────────────────────────────
// [SECURITY-FIX] Replaces a frontend call that queried Supabase's
// `bookings` table DIRECTLY from the browser (_sb.from('bookings')...) —
// two serious problems with that: (1) it used column names that don't
// exist on this table at all (booking_ref/origin/destination/order_id/
// total_amount — the real columns are booking_reference/route_label/
// duffel_order_id/customer_paid), so every result silently came back
// empty or broken; and (2) with no RLS policy defined anywhere in this
// schema, a browser-side query filtered by .eq('user_id', ...) is a
// courtesy, not a security boundary — a user could edit the request and
// read every customer's bookings. This endpoint runs server-side with the
// service key, uses req.userId from the verified auth token (never
// anything the client claims), and returns only that user's own rows with
// the actual column names.
app.get('/my-bookings', attachUserIfPresent, rateLimit('order-status', 30, 60000), async (req, res) => {
  try {
    if (!req.userId) return res.status(401).json({ ok: false, error: 'Nicht angemeldet' });
    if (!supa) return res.status(503).json({ ok: false, error: 'Datenbank nicht verfügbar' });
    const { data, error } = await supa.from('bookings')
      .select('booking_reference, duffel_order_id, route_label, status, currency, customer_paid, created_at')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json({
      ok: true,
      bookings: (data || []).map((b) => ({
        bookingReference: b.booking_reference,
        orderId: b.duffel_order_id,
        routeLabel: b.route_label,
        status: b.status,
        currency: b.currency,
        customerPaid: Number(b.customer_paid) || 0,
        createdAt: b.created_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
};
