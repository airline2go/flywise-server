// ═══════════════════════════════════════════════════════════════
// src/services/pendingBookings.js
// تخزين بيانات الحجز المؤقتة وقت إنشاء جلسة الدفع، لحد ما Duffel
// يأكّد الحجز فعلياً. بيعيش في قاعدة البيانات (يعيش بعد إعادة تشغيل
// السيرفر)، مع نسخة احتياطية في الذاكرة لو Supabase مش متاح.
//
// وكمان: حالة الحجز (pending → paid → booked / failed) عشان
// الفرونت إند يقدر يستكمل الحالة بعد ريفريش أو قفل المتصفح.
// ═══════════════════════════════════════════════════════════════

const supa = require('../clients/supabase');
const log = require('../utils/log');


// survive restarts and work across instances; falls back to in-memory if
// Supabase isn't configured.
const pendingBookings = new Map(); // fallback / cache
async function rememberBooking(sessionId, payload) {
  pendingBookings.set(sessionId, { payload, at: Date.now() });
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [k, v] of pendingBookings) { if (v.at < cutoff) pendingBookings.delete(k); }
  if (supa) {
    try {
      await supa.from('pending_bookings').upsert({
        session_id: sessionId, payload, status: 'pending',
      }, { onConflict: 'session_id' });
    } catch (e) { log('error', 'supa_pending_upsert_failed', { error: e.message }); }
  }
}
async function getPendingBooking(sessionId) {
  if (supa) {
    try {
      const { data } = await supa.from('pending_bookings').select('*').eq('session_id', sessionId).maybeSingle();
      if (data) {
        return {
          payload: data.payload,
          duffel_order_id: data.duffel_order_id || '',
          duffel_ref: data.duffel_ref || '',
        };
      }
    } catch (e) { log('error', 'supa_pending_get_failed', { error: e.message }); }
  }
  return pendingBookings.get(sessionId) || null;
}
async function markPendingBooked(sessionId, orderId, ref) {
  const entry = pendingBookings.get(sessionId);
  if (entry) { entry.duffel_order_id = orderId; entry.duffel_ref = ref; pendingBookings.set(sessionId, entry); }
  if (supa) {
    try {
      await supa.from('pending_bookings').update({
        status: 'booked', duffel_order_id: orderId, duffel_ref: ref,
      }).eq('session_id', sessionId);
    } catch (e) { log('error', 'supa_pending_update_failed', { error: e.message }); }
  }
}

// ─── [#4] Booking status store (pending → paid → booked / failed) ─────────
// Lets the frontend recover a booking after a refresh/closed browser via
// GET /booking-status/:sessionId. (Swap for a DB/Redis in production.)
const bookingStatus = new Map();
function setBookingStatus(sessionId, status, extra) {
  if (!sessionId) return;
  bookingStatus.set(sessionId, Object.assign({ status, at: Date.now() }, extra || {}));
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k, v] of bookingStatus) { if (v.at < cutoff) bookingStatus.delete(k); }
}

function getBookingStatus(sessionId) {
  return bookingStatus.get(sessionId) || null;
}

module.exports = {
  rememberBooking,
  getPendingBooking,
  markPendingBooked,
  setBookingStatus,
  getBookingStatus,
};
