// ═══════════════════════════════════════════════════════════════
// src/services/loyalty.js
// برنامج الولاء بالكامل من طرف السيرفر — كل الأرقام قابلة للتعديل
// من لوحة الأدمن، ورصيد كل عميل محفوظ في قاعدة البيانات (مش في
// localStorage القابل للتلاعب). "الحساب" = صف واحد لكل device_id
// (زائر مجهول) أو user_id (مسجّل دخول).
// ═══════════════════════════════════════════════════════════════

const supa = require('../clients/supabase');
const log = require('../utils/log');
const { getAdminConfig, computeTieredMargin, getTicketProfitTiers, getAncillaryProfitTiers } = require('./adminConfig');

// ─── [ADMIN-LOYALTY] Server-side loyalty program ───────────────────────
// Every number here used to live hardcoded in frontend JS (and the credit
// balance itself lived in localStorage, fully editable via devtools — an
// unlimited-discount hole). Now: every number is admin-tunable via
// /admin/loyalty-config, and the actual credit balance per device lives in
// loyalty_accounts, readable/writable ONLY by the server. There is no login
// system, so "account" = one row per client-generated device_id (a UUID
// the frontend generates once and keeps in localStorage) — this isn't a
// real auth system, but it does mean a tampered localStorage value can no
// longer change what credit the server thinks is available.
const DEFAULT_LOYALTY_CONFIG = {
  welcomeCreditEur: 10.0,
  welcomePoints: 100,
  pointsPerEuro: 2,
  pointsPerEuroRedeem: 400,
  maxCreditPerBooking: 5.0,
  tiers: [
    { from: 0, to: 75, creditEur: 1 },
    { from: 75, to: 149, creditEur: 2 },
    { from: 149, to: 224, creditEur: 3 },
    { from: 224, to: 299, creditEur: 4 },
    { from: 299, to: null, creditEur: 5 },
  ],
};
async function getLoyaltyConfig() { return getAdminConfig('loyalty_config', DEFAULT_LOYALTY_CONFIG); }

// How much credit COULD be used for a given subtotal, per the admin's
// tiers — independent of how much the account actually has.
function creditUsableForSubtotal(subtotal, cfg) {
  const tiers = Array.isArray(cfg.tiers) && cfg.tiers.length ? cfg.tiers : DEFAULT_LOYALTY_CONFIG.tiers;
  for (const t of tiers) {
    const inFrom = subtotal >= Number(t.from || 0);
    const inTo = t.to === null || t.to === undefined || subtotal < Number(t.to);
    if (inFrom && inTo) return Number(t.creditEur) || 0;
  }
  const last = tiers[tiers.length - 1];
  return Number(last.creditEur) || 0;
}

// [LOYALTY-LEDGER] Fire-and-forget insert into the loyalty_transactions
// ledger — purely additive, never blocks or alters the balance mutation
// it's logging (same fire-and-forget shape as logAdminActivity). kind/id
// follow the same device|user convention as every other function here,
// so anonymous-device accounts get logged too, not just registered users.
async function logLoyaltyTransaction(kind, id, type, amount, balanceAfter, note) {
  if (!supa || !id) return;
  const column = kind === 'device' ? 'device_id' : 'user_id';
  try {
    await supa.from('loyalty_transactions').insert({
      [column]: id,
      type,
      amount,
      balance_after: balanceAfter,
      note: note || null,
    });
  } catch (e) {
    log('warn', 'loyalty_transaction_log_failed', { type, error: e.message });
  }
}

// Looks up (or lazily creates) a loyalty account for either an anonymous
// device or a logged-in user. `kind` is 'device' or 'user'; `id` is the
// device_id or user_id respectively. This is the ONLY place that touches
// loyalty_accounts directly — every caller goes through here so device-
// vs-user accounts are handled identically everywhere else.
async function getOrCreateLoyaltyAccount(kind, id) {
  if (!supa || !id || (kind !== 'device' && kind !== 'user')) return null;
  const column = kind === 'device' ? 'device_id' : 'user_id';
  try {
    const { data } = await supa.from('loyalty_accounts').select('*').eq(column, id).maybeSingle();
    if (data) return data;
    const cfg = await getLoyaltyConfig();
    const welcomePts = Number(cfg.welcomePoints) || 0;
    const fresh = {
      [column]: id,
      points: welcomePts,
      // [TIER-DEMOTION-FIX] lifetime_points only ever increases (earned via
      // bookings) — tier is computed from this, never from the spendable
      // `points` balance, so redeeming points for credit can no longer pull
      // a customer back down a tier they already earned.
      lifetime_points: welcomePts,
      credit: Number(cfg.welcomeCreditEur) || 0,
      credit_used: 0, bookings_count: 0, tier: 'bronze',
    };
    const { data: inserted, error } = await supa.from('loyalty_accounts').insert(fresh).select().maybeSingle();
    if (error) { log('warn', 'loyalty_account_create_failed', { error: error.message }); return null; }
    return inserted;
  } catch (e) {
    log('warn', 'loyalty_account_lookup_failed', { error: e.message });
    return null;
  }
}

// [ADMIN-LOYALTY] Server-authoritative discount: never trusts a credit
// amount the browser asks for — clamps to (a) the admin's tier table for
// this subtotal, (b) the admin's absolute per-booking ceiling, and (c) the
// account's actual remaining balance. The smallest of the three wins.
async function computeLoyaltyDiscount(kind, id, subtotal) {
  if (!id) return { discount: 0, account: null };
  const account = await getOrCreateLoyaltyAccount(kind, id);
  if (!account) return { discount: 0, account: null };
  const cfg = await getLoyaltyConfig();
  const tierAllowance = creditUsableForSubtotal(subtotal, cfg);
  const ceiling = Number(cfg.maxCreditPerBooking) || 0;
  const discount = Math.round(Math.max(0, Math.min(tierAllowance, ceiling, Number(account.credit) || 0)) * 100) / 100;
  return { discount, account };
}

// Deducts used credit + awards points for a confirmed booking. Called only
// from bookFromSession, after Duffel has actually confirmed the order —
// never speculatively before payment succeeds. Returns the exact points
// earned, so the caller can persist it on the booking row itself — a
// later cancellation must reverse this EXACT figure, not a value
// recomputed against whatever tier the account happens to be at by then.
async function applyLoyaltyForBooking(kind, id, creditUsed, paidAmount) {
  if (!supa || !id) return 0;
  const column = kind === 'device' ? 'device_id' : 'user_id';
  try {
    const account = await getOrCreateLoyaltyAccount(kind, id);
    if (!account) return 0;
    const cfg = await getLoyaltyConfig();
    const tierMultiplier = account.tier === 'gold' ? 2 : account.tier === 'silver' ? 1.5 : 1;
    const earned = Math.floor((Number(paidAmount) || 0) * (Number(cfg.pointsPerEuro) || 0) * tierMultiplier);
    const newCredit = Math.max(0, Math.round(((Number(account.credit) || 0) - (Number(creditUsed) || 0)) * 100) / 100);
    const newPoints = (Number(account.points) || 0) + earned;
    // [TIER-DEMOTION-FIX] Tier is now driven by lifetime_points (falls back
    // to the current points balance for accounts created before this
    // column existed, so nothing breaks pre-migration) — a counter that
    // only ever grows from earning, never shrinks from redeeming.
    const currentLifetime = (account.lifetime_points != null ? Number(account.lifetime_points) : Number(account.points)) || 0;
    const newLifetime = currentLifetime + earned;
    const newTier = newLifetime >= 10000 ? 'gold' : newLifetime >= 4000 ? 'silver' : 'bronze';
    await supa.from('loyalty_accounts').update({
      credit: newCredit,
      credit_used: Math.round(((Number(account.credit_used) || 0) + (Number(creditUsed) || 0)) * 100) / 100,
      points: newPoints,
      lifetime_points: newLifetime,
      bookings_count: (Number(account.bookings_count) || 0) + 1,
      tier: newTier,
    }).eq(column, id);
    const usedAmount = Math.round((Number(creditUsed) || 0) * 100) / 100;
    if (usedAmount > 0) logLoyaltyTransaction(kind, id, 'booking_usage', -usedAmount, newCredit);
    return earned;
  } catch (e) {
    log('warn', 'loyalty_apply_failed', { error: e.message });
    return 0;
  }
}

// [LOYALTY-CANCEL-REVERSAL-FIX] Mirror image of applyLoyaltyForBooking,
// called on cancellation — reverses a FAIR PROPORTION (refundRatio, the
// same ratio used for the Stripe refund itself) of exactly what THIS
// booking actually did to the account: gives back that fraction of the
// credit that was used, removes that fraction of the points that were
// earned, decrements lifetime_points by the same amount (so a tier
// upgrade earned partly or wholly from this booking is correctly undone
// — recalculated fresh from the resulting lifetime_points, never
// force-set), and decrements bookings_count. A refundRatio of 1.0 (full
// refund) reverses everything completely; a partial refund reverses the
// same proportion, consistent with how the Stripe refund itself is
// computed. Never throws — a failure here must never block the
// cancellation response itself, and is reported via the same
// sync-failure admin-notification path as the other reconciliation
// concerns on this endpoint.
async function reverseLoyaltyForBooking(kind, id, creditUsedOriginal, pointsEarnedOriginal, refundRatio) {
  if (!supa || !id) return { ok: true };
  const column = kind === 'device' ? 'device_id' : 'user_id';
  try {
    const account = await getOrCreateLoyaltyAccount(kind, id);
    if (!account) return { ok: true };
    const creditToRestore = Math.round((Number(creditUsedOriginal) || 0) * refundRatio * 100) / 100;
    const pointsToRemove = Math.floor((Number(pointsEarnedOriginal) || 0) * refundRatio);
    const newCredit = Math.round(((Number(account.credit) || 0) + creditToRestore) * 100) / 100;
    const newCreditUsed = Math.max(0, Math.round(((Number(account.credit_used) || 0) - creditToRestore) * 100) / 100);
    const newPoints = Math.max(0, (Number(account.points) || 0) - pointsToRemove);
    const currentLifetime = (account.lifetime_points != null ? Number(account.lifetime_points) : Number(account.points)) || 0;
    const newLifetime = Math.max(0, currentLifetime - pointsToRemove);
    // Tier recalculated fresh from the resulting lifetime_points — never
    // force-set — so a tier upgrade earned (even partly) from this
    // booking is correctly undone if the reduced lifetime total no
    // longer qualifies.
    const newTier = newLifetime >= 10000 ? 'gold' : newLifetime >= 4000 ? 'silver' : 'bronze';
    const { error } = await supa.from('loyalty_accounts').update({
      credit: newCredit,
      credit_used: newCreditUsed,
      points: newPoints,
      lifetime_points: newLifetime,
      bookings_count: Math.max(0, (Number(account.bookings_count) || 0) - 1),
      tier: newTier,
    }).eq(column, id);
    if (error) return { ok: false, error: error.message };
    if (creditToRestore > 0) logLoyaltyTransaction(kind, id, 'refund', creditToRestore, newCredit);
    log('info', 'loyalty_reversed_for_cancellation', { kind, id, creditToRestore, pointsToRemove, newTier, refundRatio });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Applies the ancillary (seat/baggage) margin to a single service's net
// Duffel price. Used both when DISPLAYING a price (offer/seatmaps
// endpoints) and when CHARGING the customer (checkout session) — calling
// this same function in both places is what guarantees they always agree.
async function priceWithAncillaryMargin(netPrice) {
  const tiers = await getAncillaryProfitTiers();
  const margin = computeTieredMargin(netPrice, tiers);
  return { net: netPrice, margin, display: Math.round((netPrice + margin) * 100) / 100 };
}
async function priceWithTicketMargin(netPrice) {
  const tiers = await getTicketProfitTiers();
  const margin = computeTieredMargin(netPrice, tiers);
  return { net: netPrice, margin, display: Math.round((netPrice + margin) * 100) / 100 };
}

module.exports = {
  DEFAULT_LOYALTY_CONFIG,
  getLoyaltyConfig,
  creditUsableForSubtotal,
  getOrCreateLoyaltyAccount,
  logLoyaltyTransaction,
  computeLoyaltyDiscount,
  applyLoyaltyForBooking,
  reverseLoyaltyForBooking,
  priceWithAncillaryMargin,
  priceWithTicketMargin,
};
