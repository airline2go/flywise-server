// ═══════════════════════════════════════════════════════════════
// src/services/adminConfig.js
// مخزن key/value لإعدادات الأدمن (شرائح الربح، إعداد الفواتير...)
// مع كاش قراءة (60 ثانية) عشان حسابات التسعير ماتضربش Supabase في
// كل طلب. وفيه كمان تسجيل أحداث الإلغاء/فشل الحجز/فشل المزامنة
// اللي بتظهر كتنبيهات في لوحة الأدمن.
// ═══════════════════════════════════════════════════════════════

const supa = require('../clients/supabase');
const log = require('../utils/log');

// ─── [ADMIN] admin_config key/value store ──────────────────────────────
// Used for ticket profit tiers, ancillary (seat/baggage) profit tiers,
// invoice numbering, etc. Read-through cache (60s TTL) so every pricing
// calculation doesn't hit Supabase — these values change rarely.
const DEFAULT_TICKET_TIERS = [
  { from: 0, to: 200, pct: 8, fixed: 5 },
  { from: 200, to: 500, pct: 6, fixed: 8 },
  { from: 500, to: null, pct: 4, fixed: 10 },
];
const DEFAULT_ANCILLARY_TIERS = [
  { from: 0, to: 100, pct: 10, fixed: 1 },
  { from: 100, to: 200, pct: 8, fixed: 2 },
  { from: 200, to: null, pct: 6, fixed: 3 },
];
const DEFAULT_INVOICE_CONFIG = { prefix: 'AIRPIV', nextNumber: 1, companyName: 'Airpiv', companyAddress: '', steuernummer: '', taxMode: 'kleinunternehmer' };

const _configCache = new Map(); // key -> { value, at }
const CONFIG_CACHE_TTL = 60000;

async function getAdminConfig(key, fallback) {
  const cached = _configCache.get(key);
  if (cached && Date.now() - cached.at < CONFIG_CACHE_TTL) return cached.value;
  if (supa) {
    try {
      const { data, error } = await supa.from('admin_config').select('value').eq('key', key).maybeSingle();
      if (!error && data && data.value != null) {
        _configCache.set(key, { value: data.value, at: Date.now() });
        return data.value;
      }
    } catch (e) {
      log('warn', 'admin_config_read_failed', { key, error: e.message });
    }
  }
  // No Supabase, or row missing, or read failed: fall back to the default
  // and cache it too (briefly) so we don't hammer Supabase on every request.
  _configCache.set(key, { value: fallback, at: Date.now() });
  return fallback;
}

async function setAdminConfig(key, value) {
  if (!supa) throw Object.assign(new Error('Datenbank nicht verfügbar'), { status: 503 });
  const { error } = await supa.from('admin_config').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
  _configCache.set(key, { value, at: Date.now() });
}

// [CANCEL-NOTIFY-FIX] Customer-initiated cancellations the admin has no
// other way of finding out about. Stored as a capped list (newest first,
// oldest dropped past 50) in admin_config — durable across restarts,
// consistent with everything else config-driven in this file.
async function recordCancellationEvent(entry) {
  try {
    const list = await getAdminConfig('cancellation_events', []);
    const updated = [{ ...entry, at: new Date().toISOString(), read: false }, ...list].slice(0, 50);
    await setAdminConfig('cancellation_events', updated);
  } catch (e) {
    log('warn', 'cancellation_event_record_failed', { error: e.message });
  }
}
async function getUnreadCancellationCount() {
  const list = await getAdminConfig('cancellation_events', []);
  return list.filter((e) => !e.read).length;
}
async function markCancellationsRead() {
  const list = await getAdminConfig('cancellation_events', []);
  await setAdminConfig('cancellation_events', list.map((e) => ({ ...e, read: true })));
}

// [BOOKING-FAILURE-NOTIFY] Same pattern as cancellation events — a
// booking that failed AFTER the customer already paid (offer expired,
// price drift, any unexpected Duffel/airline error) is arguably more
// urgent than a clean cancellation, since it means a customer was
// charged with no ticket (even when auto-refunded — the admin still
// needs to know it happened, in case the refund itself silently failed).
async function recordBookingFailureEvent(entry) {
  try {
    const list = await getAdminConfig('booking_failure_events', []);
    const updated = [{ ...entry, at: new Date().toISOString(), read: false }, ...list].slice(0, 50);
    await setAdminConfig('booking_failure_events', updated);
  } catch (e) {
    log('warn', 'booking_failure_event_record_failed', { error: e.message });
  }
}
async function markBookingFailuresRead() {
  const list = await getAdminConfig('booking_failure_events', []);
  await setAdminConfig('booking_failure_events', list.map((e) => ({ ...e, read: true })));
}

// [SYNC-FAILURE-NOTIFY] Deliberately generic event type for "the real
// operation succeeded externally (Duffel/Stripe), but our own database
// failed to record it" scenarios — distinct from booking_failure_events
// (customer charged, no ticket) and cancellation_events (a normal,
// successful cancellation everyone already knows about). This category
// means something more subtle and dangerous: everything succeeded for
// the customer, but our internal records have silently drifted from
// reality — e.g. a cancellation went through and the customer was
// refunded, but our bookings table still says "confirmed". Only manual
// reconciliation catches this, which is exactly why it needs its own
// loud, distinct notification rather than blending into routine
// cancellation events.
// [CANCELLATION-EMAIL-FIX] The missing piece: until now, a cancellation
// only ever showed an in-app toast — no permanent email record for the
// customer to keep, unlike every other transactional event (booking
// confirmation, password reset) which all send a real email. Matches the
// same branded visual identity as those templates. Honestly reflects
// whatever the actual refund outcome is — never claims money was
// refunded if the Stripe refund call itself failed (see stripeRefundError
// parameter), since that would be a false promise on top of an already
// difficult situation.

async function recordSyncFailureEvent(entry) {
  try {
    const list = await getAdminConfig('sync_failure_events', []);
    const updated = [{ ...entry, at: new Date().toISOString(), read: false, severity: 'critical' }, ...list].slice(0, 50);
    await setAdminConfig('sync_failure_events', updated);
  } catch (e) {
    log('warn', 'sync_failure_event_record_failed', { error: e.message });
  }
}
async function markSyncFailuresRead() {
  const list = await getAdminConfig('sync_failure_events', []);
  await setAdminConfig('sync_failure_events', list.map((e) => ({ ...e, read: true })));
}

// Same tiered-margin math as the admin dashboard's getMarginForPrice() in
// JS, kept in lockstep deliberately: { from, to(nullable), pct, fixed }[].
// `to: null` means "no upper bound". Falls back to the last tier if price
// exceeds every defined range (mirrors the dashboard's own fallback).
function computeTieredMargin(price, tiers) {
  if (!Array.isArray(tiers) || !tiers.length) return 0;
  for (const t of tiers) {
    const inFrom = price >= Number(t.from || 0);
    const inTo = t.to === null || t.to === undefined || price < Number(t.to);
    if (inFrom && inTo) return Math.round((price * (Number(t.pct) || 0) / 100 + (Number(t.fixed) || 0)) * 100) / 100;
  }
  const last = tiers[tiers.length - 1];
  return Math.round((price * (Number(last.pct) || 0) / 100 + (Number(last.fixed) || 0)) * 100) / 100;
}

async function getTicketProfitTiers() { return getAdminConfig('ticket_profit_tiers', DEFAULT_TICKET_TIERS); }
async function getAncillaryProfitTiers() { return getAdminConfig('ancillary_profit_tiers', DEFAULT_ANCILLARY_TIERS); }

function clearConfigCacheKeys(keys) {
  keys.forEach((k) => _configCache.delete(k));
}

module.exports = {
  DEFAULT_TICKET_TIERS,
  DEFAULT_ANCILLARY_TIERS,
  DEFAULT_INVOICE_CONFIG,
  getAdminConfig,
  setAdminConfig,
  clearConfigCacheKeys,
  recordCancellationEvent,
  getUnreadCancellationCount,
  markCancellationsRead,
  recordBookingFailureEvent,
  markBookingFailuresRead,
  recordSyncFailureEvent,
  markSyncFailuresRead,
  computeTieredMargin,
  getTicketProfitTiers,
  getAncillaryProfitTiers,
};
