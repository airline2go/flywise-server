// ═══════════════════════════════════════════════════════════════
// src/services/finance/reconciliation.js
// [F-PHASE2 · RECONCILIATION] Matches a booking across Stripe, Duffel, bank
// and the ledger. Rule (spec Phase 11): NEVER match on amount alone — a match
// must agree on at least one strong identity key (session/payment/order/payout
// id) AND amount+currency. The pure `scoreMatch()` is unit-tested without a DB;
// `reconcileBooking()` persists matches/exceptions.
// ═══════════════════════════════════════════════════════════════

// Strong identity keys that legitimately tie two records together.
const STRONG_KEYS = ['booking_id', 'payment_intent_id', 'stripe_session_id', 'duffel_order_id', 'payout_id'];

// Compare two record projections. Returns:
//   { status, matchedKeys, difference_minor }
// status ∈ MATCHED | PARTIALLY_MATCHED | UNMATCHED | MANUAL_REVIEW.
function scoreMatch(left, right) {
  const matchedKeys = [];
  for (const k of STRONG_KEYS) {
    if (left[k] != null && right[k] != null && String(left[k]) === String(right[k])) matchedKeys.push(k);
  }
  const sameCurrency = left.currency && right.currency &&
    String(left.currency).toUpperCase() === String(right.currency).toUpperCase();
  const la = Number(left.amount_minor); const ra = Number(right.amount_minor);
  const bothAmounts = Number.isFinite(la) && Number.isFinite(ra);
  const diff = bothAmounts ? Math.abs(la - ra) : null;

  if (matchedKeys.length === 0) {
    // No shared identity → never assert a match on amount alone.
    return { status: 'UNMATCHED', matchedKeys, difference_minor: diff };
  }
  if (bothAmounts && sameCurrency && diff === 0) {
    return { status: 'MATCHED', matchedKeys, difference_minor: 0 };
  }
  if (bothAmounts && sameCurrency && diff > 0) {
    return { status: 'PARTIALLY_MATCHED', matchedKeys, difference_minor: diff };
  }
  // Shared key but currency/amount can't be compared → a human decides.
  return { status: 'MANUAL_REVIEW', matchedKeys, difference_minor: diff };
}

// Persist a reconciliation result between two named sides.
async function persistMatch(supa, left, right, result, note) {
  return supa.from('reconciliation_matches').insert({
    status: result.status,
    left_source: left.source, left_id: left.id,
    right_source: right.source, right_id: right.id,
    match_keys: { matched: result.matchedKeys },
    amount_minor: left.amount_minor != null ? left.amount_minor : right.amount_minor,
    currency: left.currency || right.currency,
    difference_minor: result.difference_minor || 0,
    matched_by: 'system',
    matched_at: new Date().toISOString(),
    note: note || null,
  });
}

async function persistException(supa, exceptionType, side, severity, details) {
  return supa.from('reconciliation_exceptions').insert({
    exception_type: exceptionType,
    source: side.source, source_id: side.id,
    booking_id: side.booking_id || null,
    amount_minor: side.amount_minor || null,
    currency: side.currency || null,
    difference_minor: side.difference_minor || null,
    severity: severity || 'REVIEW',
    details: details || null,
  });
}

// Reconcile one booking's booking↔stripe↔duffel legs. Loads the relevant
// records and writes matches + exceptions. Best-effort, idempotent-ish (writes
// fresh rows; callers may clear prior rows for the booking first if desired).
async function reconcileBooking(bookingId, deps = {}) {
  const { supa, log } = deps;
  if (!supa || !bookingId) return { matches: 0, exceptions: 0 };
  let matches = 0, exceptions = 0;

  const [{ data: booking }, { data: stripeTx }, { data: duffelLines }] = await Promise.all([
    supa.from('bookings').select('id, stripe_session_id, stripe_payment_id, duffel_order_id, customer_paid, currency').eq('id', bookingId).maybeSingle(),
    supa.from('stripe_transactions').select('*').eq('booking_id', bookingId),
    supa.from('duffel_invoice_lines').select('*').eq('booking_id', bookingId),
  ]);

  if (!booking) {
    await persistException(supa, 'BOOKING_NOT_FOUND', { source: 'booking', id: bookingId }, 'CRITICAL', null);
    return { matches: 0, exceptions: 1 };
  }

  const bookingSide = {
    source: 'booking', id: booking.id, booking_id: booking.id,
    payment_intent_id: booking.stripe_payment_id, stripe_session_id: booking.stripe_session_id,
    duffel_order_id: booking.duffel_order_id,
    amount_minor: booking.customer_paid != null ? Math.round(Number(booking.customer_paid) * 100) : null,
    currency: booking.currency || 'EUR',
  };

  // Stripe leg
  if (!stripeTx || stripeTx.length === 0) {
    await persistException(supa, 'STRIPE_UNMATCHED', bookingSide, 'REVIEW', { reason: 'no_stripe_transaction' });
    exceptions++;
  } else {
    for (const tx of stripeTx) {
      const stripeSide = { source: 'stripe', id: tx.stripe_id, booking_id: bookingId,
        payment_intent_id: tx.source_id, payout_id: tx.payout_id,
        amount_minor: tx.gross_minor, currency: tx.currency };
      const r = scoreMatch(bookingSide, stripeSide);
      await persistMatch(supa, bookingSide, stripeSide, r, 'booking↔stripe');
      matches++;
      if (r.status !== 'MATCHED') { await persistException(supa, 'BOOKING_AMOUNT_MISMATCH', { ...stripeSide, difference_minor: r.difference_minor }, 'REVIEW', { leg: 'stripe' }); exceptions++; }
    }
  }

  // Duffel leg
  if (!duffelLines || duffelLines.length === 0) {
    await persistException(supa, 'DUFFEL_UNMATCHED', bookingSide, 'REVIEW', { reason: 'no_duffel_invoice_line' });
    exceptions++;
  } else {
    for (const dl of duffelLines) {
      const duffelSide = { source: 'duffel', id: dl.id, booking_id: bookingId,
        duffel_order_id: dl.order_id, amount_minor: dl.gross_minor, currency: dl.currency };
      const r = scoreMatch({ ...bookingSide, amount_minor: dl.gross_minor }, duffelSide);
      await persistMatch(supa, bookingSide, duffelSide, r, 'booking↔duffel');
      matches++;
    }
  }

  if (log) log('info', 'reconcile_booking_done', { booking_id: bookingId, matches, exceptions });
  return { matches, exceptions };
}

module.exports = { STRONG_KEYS, scoreMatch, reconcileBooking, persistMatch, persistException };
