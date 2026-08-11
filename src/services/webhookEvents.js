// ═══════════════════════════════════════════════════════════════
// src/services/webhookEvents.js
// [F3/F5 · WEBHOOK-DURABILITY] تخزين دائم لأحداث الـwebhooks (Stripe
// وDuffel) مع منع التكرار (idempotency). قبل كده كان الحدث بيتعالج في
// الذاكرة بعد ACK 200، ولو فشلت المعالجة بعد الـACK كان بيضيع (Sentry
// بس). دلوقتي كل حدث بيتسجّل بمعرّفه الفريد (UNIQUE) قبل المعالجة:
//   - نفس الحدث ميتعالجش مرتين (لو اتعالج خلاص → نتجاهله).
//   - لو فشل → status='processing_failed' عشان job استرجاع يعيده لاحقاً.
// لو Supabase مش متاح، بنرجّع { durable:false } والـcaller يكمّل زي
// السلوك القديم بالظبط (best-effort) — الموقع أبداً معتمدش على وجود
// الجداول دي عشان يشتغل.
// ═══════════════════════════════════════════════════════════════

const supa = require('../clients/supabase');
const log = require('../utils/log');

const STRIPE = { table: 'stripe_webhook_events', idColumn: 'stripe_event_id' };
const DUFFEL = { table: 'duffel_webhook_events', idColumn: 'duffel_event_id' };

// يسجّل بداية معالجة حدث ويقرّر هل نعالجه ولا نتخطاه.
// بيرجّع:
//   { durable:false }                          — لا يوجد تخزين (supa/id ناقص) → عالج best-effort
//   { durable:true, alreadyProcessed:true }    — الحدث اتعالج خلاص → اتخطاه
//   { durable:true, alreadyProcessed:false }   — أول مرة أو محاولة سابقة فشلت → عالجه
async function beginEvent(cfg, eventId, meta) {
  if (!supa || !eventId) return { durable: false };
  const { table, idColumn } = cfg;
  try {
    const { data: existing } = await supa.from(table)
      .select('status, retry_count').eq(idColumn, eventId).maybeSingle();
    if (existing) {
      if (existing.status === 'processed') return { durable: true, alreadyProcessed: true };
      // محاولة سابقة لسه 'received' أو فشلت → نزوّد العداد ونعيد المعالجة.
      await supa.from(table)
        .update({ status: 'received', retry_count: (existing.retry_count || 0) + 1, last_error: null })
        .eq(idColumn, eventId);
      return { durable: true, alreadyProcessed: false };
    }
    const row = Object.assign({ [idColumn]: eventId, status: 'received' }, meta || {});
    const { error } = await supa.from(table).insert(row);
    if (error) {
      // 23505 = unique_violation: instance تاني سجّله في نفس اللحظة → نعيد القراءة.
      if (error.code === '23505') {
        const { data: race } = await supa.from(table).select('status').eq(idColumn, eventId).maybeSingle();
        if (race && race.status === 'processed') return { durable: true, alreadyProcessed: true };
        return { durable: true, alreadyProcessed: false };
      }
      log('warn', 'webhook_event_begin_insert_failed', { table, error: error.message });
      return { durable: false };
    }
    return { durable: true, alreadyProcessed: false };
  } catch (e) {
    log('warn', 'webhook_event_begin_failed', { table, error: e.message });
    return { durable: false };
  }
}

async function completeEvent(cfg, eventId) {
  if (!supa || !eventId) return;
  try {
    await supa.from(cfg.table)
      .update({ status: 'processed', processed_at: new Date().toISOString() })
      .eq(cfg.idColumn, eventId);
  } catch (e) {
    log('warn', 'webhook_event_complete_failed', { table: cfg.table, error: e.message });
  }
}

async function failEvent(cfg, eventId, errMessage) {
  if (!supa || !eventId) return;
  try {
    await supa.from(cfg.table)
      .update({ status: 'processing_failed', last_error: String(errMessage || '').slice(0, 2000) })
      .eq(cfg.idColumn, eventId);
  } catch (e) {
    log('warn', 'webhook_event_fail_update_failed', { table: cfg.table, error: e.message });
  }
}

// ─── Stripe wrappers ──────────────────────────────────────
function beginStripeEvent(event) {
  const obj = (event && event.data && event.data.object) || {};
  return beginEvent(STRIPE, event && event.id, {
    type: event && event.type,
    session_id: obj.id && String(obj.id).startsWith('cs_') ? obj.id : null,
    payment_intent: obj.payment_intent || (obj.id && String(obj.id).startsWith('pi_') ? obj.id : null) || null,
  });
}
const completeStripeEvent = (id) => completeEvent(STRIPE, id);
const failStripeEvent = (id, err) => failEvent(STRIPE, id, err);

// ─── Duffel wrappers ──────────────────────────────────────
function beginDuffelEvent(event) {
  return beginEvent(DUFFEL, event && event.id, { type: event && event.type });
}
const completeDuffelEvent = (id) => completeEvent(DUFFEL, id);
const failDuffelEvent = (id, err) => failEvent(DUFFEL, id, err);

module.exports = {
  beginStripeEvent, completeStripeEvent, failStripeEvent,
  beginDuffelEvent, completeDuffelEvent, failDuffelEvent,
  // exported for direct unit testing
  _beginEvent: beginEvent, _completeEvent: completeEvent, _failEvent: failEvent,
  _STRIPE: STRIPE, _DUFFEL: DUFFEL,
};
