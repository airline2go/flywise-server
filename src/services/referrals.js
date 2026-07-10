// ═══════════════════════════════════════════════════════════════
// src/services/referrals.js
// [REFERRAL-REBUILD] The referral program used to be entirely
// client-side: app.js wrote directly to a Supabase `referrals` table
// that never existed, and separately incremented a `loyaltyData.credit`
// variable held only in the browser's own memory/localStorage. No
// referral has ever actually paid out real, spendable credit — the
// "🎉 you got €10" toast was always cosmetic. This rebuilds it as a
// real, server-authoritative feature: every write happens here, using
// data the server itself verified (a real confirmed booking's real
// Duffel departure date — never anything the client sends).
// ═══════════════════════════════════════════════════════════════

const supa = require('../clients/supabase');
const log = require('../utils/log');
const { getOrCreateLoyaltyAccount, logLoyaltyTransaction } = require('./loyalty');

const REWARD_EUR = 10;

// Same hash exactly as the frontend's referralCodeFor() (app.js) — kept
// byte-for-byte identical so a code already shared via an old link still
// resolves to the same account. JS's `|0` truncation is identical between
// Node and the browser, so this is a verbatim port, not a re-implementation.
function referralCodeFor(userId) {
  const s = String(userId || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i) | 0;
  let code = Math.abs(h).toString(36).toUpperCase().slice(0, 6);
  while (code.length < 6) code += '0';
  return 'AP-' + code;
}

// Lazily backfills loyalty_accounts.referral_code the first time a given
// user is touched by the referral system — no need to migrate every
// existing row up front. Idempotent: a second call for the same user is a
// harmless no-op (the column is already set).
async function getOrCreateReferralCode(userId) {
  if (!supa || !userId) return null;
  const account = await getOrCreateLoyaltyAccount('user', userId);
  if (!account) return null;
  if (account.referral_code) return account.referral_code;
  const code = referralCodeFor(userId);
  const { error } = await supa.from('loyalty_accounts').update({ referral_code: code }).eq('user_id', userId);
  if (error) { log('warn', 'referral_code_backfill_failed', { userId, error: error.message }); return code; }
  return code;
}

// Called right after a NEW user's account is confirmed (mirrors the old
// client-side referralLinkNewUser). referrerCode is whatever the visitor's
// browser captured from a `?ref=` URL param — untrusted input, resolved
// here against the real, indexed referral_code column rather than trusted
// directly. referredUserId/referredEmail come from the caller's own
// VERIFIED auth token, never the request body.
async function linkNewUser(referredUserId, referredEmail, referrerCode) {
  if (!supa || !referredUserId || !referrerCode) return { linked: false };
  try {
    const { data: referrerAccount } = await supa.from('loyalty_accounts')
      .select('user_id').eq('referral_code', String(referrerCode).trim().toUpperCase()).maybeSingle();
    if (!referrerAccount || !referrerAccount.user_id) return { linked: false, reason: 'unknown_code' };
    if (referrerAccount.user_id === referredUserId) return { linked: false, reason: 'self_referral' };

    // referred_id is UNIQUE — a user who already has a referral row
    // (they were already linked, whether just now or in the past) is
    // silently left alone rather than erroring; this can only naturally
    // happen if the client calls this endpoint twice for the same user.
    const { data: existing } = await supa.from('referrals').select('id').eq('referred_id', referredUserId).maybeSingle();
    if (existing) return { linked: false, reason: 'already_linked' };

    const { error } = await supa.from('referrals').insert({
      referrer_id: referrerAccount.user_id,
      referred_id: referredUserId,
      referred_email: referredEmail || null,
      status: 'awaiting_booking',
    });
    if (error) { log('warn', 'referral_link_failed', { error: error.message }); return { linked: false, reason: 'db_error' }; }
    return { linked: true };
  } catch (e) {
    log('warn', 'referral_link_exception', { error: e.message });
    return { linked: false, reason: 'exception' };
  }
}

// Called from bookFromSession() right after Duffel confirms a real order
// AND the corresponding bookings row has been inserted. orderData is the
// Duffel order response (result.data from POST /air/orders) —
// departure_date is read from its real slices/segments, never from
// anything the client sent at checkout. Looks up the bookings row's own
// id from duffelOrderId itself (same pattern as reverseReferralForBooking)
// rather than requiring the caller to plumb it through. A safe no-op if
// this user was never referred, or was already attached to a previous
// booking.
async function attachBookingIfReferred(userId, duffelOrderId, orderData) {
  if (!supa || !userId || !duffelOrderId) return;
  try {
    const { data: referral } = await supa.from('referrals')
      .select('id').eq('referred_id', userId).eq('status', 'awaiting_booking').maybeSingle();
    if (!referral) return;

    const firstSegment = orderData && orderData.slices && orderData.slices[0] && orderData.slices[0].segments && orderData.slices[0].segments[0];
    const departureDate = firstSegment && firstSegment.departing_at ? firstSegment.departing_at : null;
    if (!departureDate) { log('warn', 'referral_attach_no_departure_date', { userId, duffelOrderId }); return; }

    const { data: bookingRow } = await supa.from('bookings').select('id').eq('duffel_order_id', duffelOrderId).maybeSingle();
    if (!bookingRow) { log('warn', 'referral_attach_booking_row_not_found', { duffelOrderId }); return; }

    const { error } = await supa.from('referrals').update({
      booking_id: bookingRow.id,
      departure_date: departureDate,
      status: 'pending',
    }).eq('id', referral.id);
    if (error) log('warn', 'referral_attach_failed', { error: error.message });
  } catch (e) {
    log('warn', 'referral_attach_exception', { error: e.message });
  }
}

// Credits REWARD_EUR to a single account, mirroring the update pattern
// used throughout loyalty.js (fetch account, compute new value, write it).
async function creditReward(userId) {
  const account = await getOrCreateLoyaltyAccount('user', userId);
  if (!account) return false;
  const newCredit = Math.round(((Number(account.credit) || 0) + REWARD_EUR) * 100) / 100;
  const { error } = await supa.from('loyalty_accounts').update({ credit: newCredit }).eq('user_id', userId);
  if (error) { log('warn', 'referral_credit_failed', { userId, error: error.message }); return false; }
  logLoyaltyTransaction('user', userId, 'reward', REWARD_EUR, newCredit, 'referral_reward');
  return true;
}

// Called on login/page-load for the current user (mirrors the old
// referralCheckAndPayout trigger point) — checks the caller's OWN
// referral rows in EITHER role (they may be a referrer, a referred party,
// or both across different referrals) and pays out any that are now due:
// status='pending' and the real departure_date has passed. Each side is
// paid independently and exactly once, tracked by its own *_paid flag, so
// whichever party happens to log in first doesn't block or double-pay the
// other. Returns how much was JUST credited this call, so the client can
// show a truthful toast instead of a fixed, possibly-false amount.
async function checkAndPayout(userId) {
  if (!supa || !userId) return { creditedNow: 0 };
  try {
    const nowIso = new Date().toISOString();
    const { data: rows } = await supa.from('referrals')
      .select('*')
      .eq('status', 'pending')
      .or(`referrer_id.eq.${userId},referred_id.eq.${userId}`)
      .lte('departure_date', nowIso);
    if (!rows || !rows.length) return { creditedNow: 0 };

    let creditedNow = 0;
    for (const row of rows) {
      let referrerPaid = row.reward_referrer_paid;
      let referredPaid = row.reward_referred_paid;
      if (row.referrer_id === userId && !referrerPaid) {
        if (await creditReward(userId)) { referrerPaid = true; creditedNow += REWARD_EUR; }
      }
      if (row.referred_id === userId && !referredPaid) {
        if (await creditReward(userId)) { referredPaid = true; creditedNow += REWARD_EUR; }
      }
      const newStatus = referrerPaid && referredPaid ? 'completed' : row.status;
      await supa.from('referrals').update({
        reward_referrer_paid: referrerPaid,
        reward_referred_paid: referredPaid,
        status: newStatus,
      }).eq('id', row.id);
    }
    return { creditedNow };
  } catch (e) {
    log('warn', 'referral_payout_exception', { error: e.message });
    return { creditedNow: 0 };
  }
}

// Called from the cancellation flow (cancel.routes.js) once a booking is
// confirmed cancelled with Duffel. Reverses whichever reward(s) had
// already been paid out for the referral tied to this exact booking, and
// marks the referral cancelled so it's never paid (or paid again) later.
async function reverseReferralForBooking(duffelOrderId) {
  if (!supa || !duffelOrderId) return;
  try {
    const { data: bookingRow } = await supa.from('bookings').select('id').eq('duffel_order_id', duffelOrderId).maybeSingle();
    if (!bookingRow) return;
    const { data: referral } = await supa.from('referrals')
      .select('*').eq('booking_id', bookingRow.id).in('status', ['pending', 'completed']).maybeSingle();
    if (!referral) return;

    if (referral.reward_referrer_paid) await reverseReward(referral.referrer_id);
    if (referral.reward_referred_paid) await reverseReward(referral.referred_id);

    const { error } = await supa.from('referrals').update({ status: 'cancelled' }).eq('id', referral.id);
    if (error) log('warn', 'referral_cancel_sync_failed', { error: error.message });
  } catch (e) {
    log('warn', 'referral_reverse_exception', { error: e.message });
  }
}

async function reverseReward(userId) {
  const account = await getOrCreateLoyaltyAccount('user', userId);
  if (!account) return;
  const newCredit = Math.max(0, Math.round(((Number(account.credit) || 0) - REWARD_EUR) * 100) / 100);
  const { error } = await supa.from('loyalty_accounts').update({ credit: newCredit }).eq('user_id', userId);
  if (error) { log('warn', 'referral_reverse_credit_failed', { userId, error: error.message }); return; }
  logLoyaltyTransaction('user', userId, 'reward', -REWARD_EUR, newCredit, 'referral_reward_reversed');
}

// The caller's own "who did I invite" list (mirrors the old client-side
// referralLoadList, now server-verified and scoped to req.userId).
// Embeds the linked booking's real, human-readable reference via
// Supabase's FK-based join instead of exposing the internal booking_id.
async function getMyReferralList(userId) {
  if (!supa || !userId) return [];
  const { data } = await supa.from('referrals')
    .select('referred_email,status,created_at,bookings(booking_reference)')
    .eq('referrer_id', userId)
    .order('created_at', { ascending: false });
  return (data || []).map((row) => ({
    referred_email: row.referred_email,
    status: row.status,
    created_at: row.created_at,
    booking_reference: (row.bookings && row.bookings.booking_reference) || null,
  }));
}

module.exports = {
  REWARD_EUR,
  referralCodeFor,
  getOrCreateReferralCode,
  linkNewUser,
  attachBookingIfReferred,
  checkAndPayout,
  reverseReferralForBooking,
  getMyReferralList,
};
