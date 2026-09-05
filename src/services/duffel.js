// ═══════════════════════════════════════════════════════════════
// src/services/duffel.js
// كل تعامل مع Duffel API بيعدي من هنا. فيها 3 طبقات حماية:
// 1. Timeout 20 ثانية لكل طلب (مايفضلش معلّق للأبد)
// 2. Retry تلقائي مرة واحدة على الأخطاء المؤقتة بس (شبكة/5xx)،
//    مش على أخطاء منطقية زي "مفيش عروض" (4xx)
// 3. Circuit Breaker: لو فشل 5 مرات متتالية، يوقف يحاول لمدة 30
//    ثانية ويرجّع خطأ سريع بدل ما يخنق السيرفر بطلبات محكوم عليها بالفشل
// ═══════════════════════════════════════════════════════════════

const env = require('../config/env');
const log = require('../utils/log');
const Sentry = require('../clients/sentry');
const { recordApiLog } = require('./apiLogs');

const DUFFEL_TIMEOUT_MS = 20000;

async function duffelAttempt(method, path, body, extraHeaders, timeoutMs, externalSignal) {
  if (!env.DUFFEL_TOKEN) throw new Error('DUFFEL_TOKEN غير موجود في Environment Variables');

  const opts = {
    method,
    headers: Object.assign({
      Authorization: `Bearer ${env.DUFFEL_TOKEN}`,
      'Content-Type': 'application/json',
      'Duffel-Version': env.DUFFEL_VERSION,
      Accept: 'application/json',
    }, extraHeaders || {}),
  };
  if (body) opts.body = JSON.stringify(body);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || DUFFEL_TIMEOUT_MS);
  // [P0.8 · DEADLINE] An optional external signal (a caller's overall
  // deadline — see computeAuthoritativePricing) must ALSO abort this
  // in-flight request the instant it fires, not wait for the per-attempt
  // timeout. Forward it onto the same controller so the fetch is actually
  // cancelled (no Duffel request left running in the background).
  let onExternalAbort = null;
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort();
    else { onExternalAbort = () => ctrl.abort(); externalSignal.addEventListener('abort', onExternalAbort, { once: true }); }
  }
  opts.signal = ctrl.signal;

  let res;
  try {
    res = await fetch(`${env.DUFFEL_BASE}${path}`, opts);
  } catch (e) {
    if (e.name === 'AbortError') {
      // Distinguish the caller's overall deadline from our own per-request
      // timeout: the deadline is terminal (never retried), the timeout is
      // a transient error that may be retried once.
      const deadlineHit = !!(externalSignal && externalSignal.aborted);
      const err = new Error(deadlineHit
        ? 'Zeitlimit für die Preisberechnung überschritten'
        : 'Duffel antwortet nicht — bitte erneut versuchen');
      err.status = 504;
      if (deadlineHit) err.code = 'UPSTREAM_DEADLINE';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (externalSignal && onExternalAbort) externalSignal.removeEventListener('abort', onExternalAbort);
  }
  const json = await res.json();

  if (!res.ok) {
    const msg = json?.errors?.[0]?.message || 'Duffel API Error';
    const err = new Error(msg);
    err.status = res.status;
    err.details = json?.errors;
    throw err;
  }
  return json;
}

// [DUFFEL-CIRCUIT-BREAKER] 3 حالات، متتبعة في الذاكرة (لكل نسخة
// سيرفر — مقبول هنا لأن Render بيشغّل ده كـ process واحد):
//   closed    — تشغيل عادي، كل طلب بيعدي.
//   open      — فشل 5 مرات متتالية؛ كل طلب بيترفض فوراً من غير
//               أي محاولة اتصال، لمدة 30 ثانية — عشان عطل حقيقي
//               في Duffel ميخنقش السيرفر بمئات الطلبات المحكوم
//               عليها بالفشل مسبقاً.
//   half-open — انتهت فترة الانتظار؛ الطلب الجاي بيتاخد كتجربة.
//               نجاح = يقفل الدائرة تاني. فشل = يفتحها فوراً لفترة
//               كاملة جديدة.
let duffelCircuitState = 'closed';
let duffelFailureCount = 0;
let duffelCircuitOpenedAt = 0;
const DUFFEL_FAILURE_THRESHOLD = 5;
const DUFFEL_CIRCUIT_COOLDOWN_MS = 30000;

function duffelCircuitAllow() {
  if (duffelCircuitState !== 'open') return true;
  if (Date.now() - duffelCircuitOpenedAt > DUFFEL_CIRCUIT_COOLDOWN_MS) {
    duffelCircuitState = 'half-open';
    return true;
  }
  return false;
}
function duffelCircuitRecordSuccess() {
  if (duffelCircuitState !== 'closed') log('info', 'duffel_circuit_closed', {});
  duffelFailureCount = 0;
  duffelCircuitState = 'closed';
}
function duffelCircuitRecordFailure() {
  duffelFailureCount++;
  if (duffelCircuitState === 'half-open') {
    duffelCircuitState = 'open';
    duffelCircuitOpenedAt = Date.now();
    log('warn', 'duffel_circuit_reopened', {});
    return;
  }
  if (duffelFailureCount >= DUFFEL_FAILURE_THRESHOLD && duffelCircuitState === 'closed') {
    duffelCircuitState = 'open';
    duffelCircuitOpenedAt = Date.now();
    log('error', 'duffel_circuit_opened', { failures: duffelFailureCount });
    if (env.SENTRY_DSN) Sentry.captureMessage('Duffel circuit breaker opened — API considered down', 'error');
  }
}

// [DUFFEL-RETRY] بيعيد المحاولة بس على الأخطاء المؤقتة (خطأ شبكة،
// timeout بتاعنا، أو 5xx من عند Duffel) — خطأ 4xx (طلب غلط، مسار
// غير صحيح، عرض منتهي) هيفشل بنفس الطريقة تاني، فإعادة المحاولة
// هتستهلك حصة Duffel وتزود التأخير من غير أي فايدة.
async function duffel(method, path, body = null, extraHeaders = null, options = null) {
  // [API-COST-MONITORING] Timed across the whole logical call, including
  // any retries below — retries are an implementation detail, not a
  // second billable-feeling event, so exactly ONE log row comes out of
  // one duffel() invocation regardless of how many attempts it took.
  const startedAt = Date.now();
  const logContext = (options && options.logContext) || null;

  if (!duffelCircuitAllow()) {
    const err = new Error('Duffel ist vorübergehend nicht erreichbar — bitte in Kürze erneut versuchen');
    err.status = 503;
    recordApiLog({ method, path, statusCode: 503, success: false, durationMs: Date.now() - startedAt, logContext });
    throw err;
  }
  const timeoutMs = (options && options.timeoutMs) || DUFFEL_TIMEOUT_MS;
  // [P0.8 · DEADLINE] Optional caller-supplied overall deadline signal. When
  // it has fired, this whole logical call ends immediately with a terminal
  // UPSTREAM_DEADLINE error — no new attempt is started and no retry is
  // scheduled. A deadline is the caller's deliberate cap, not Duffel being
  // down, so it does NOT count toward the circuit breaker.
  const externalSignal = (options && options.signal) || null;
  const deadlineError = () => { const err = new Error('Zeitlimit für die Preisberechnung überschritten'); err.status = 504; err.code = 'UPSTREAM_DEADLINE'; return err; };
  const maxAttempts = 2;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (externalSignal && externalSignal.aborted) {
      const err = deadlineError();
      recordApiLog({ method, path, statusCode: 504, success: false, durationMs: Date.now() - startedAt, logContext });
      throw err;
    }
    try {
      const result = await duffelAttempt(method, path, body, extraHeaders, timeoutMs, externalSignal);
      duffelCircuitRecordSuccess();
      recordApiLog({ method, path, statusCode: 200, success: true, durationMs: Date.now() - startedAt, logContext });
      return result;
    } catch (e) {
      lastErr = e;
      // [P0.8] A deadline abort is terminal — never retried, never counted
      // as a circuit failure. Surface it straight to the caller.
      if (e.code === 'UPSTREAM_DEADLINE') {
        recordApiLog({ method, path, statusCode: 504, success: false, durationMs: Date.now() - startedAt, logContext });
        throw e;
      }
      const transient = !e.status || e.status >= 500;
      if (!transient || attempt === maxAttempts) {
        duffelCircuitRecordFailure();
        recordApiLog({ method, path, statusCode: e.status || null, success: false, durationMs: Date.now() - startedAt, logContext });
        throw e;
      }
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
  throw lastErr;
}

function getDuffelCircuitStatus() {
  return { state: duffelCircuitState, consecutiveFailures: duffelFailureCount };
}

module.exports = duffel;
module.exports.getDuffelCircuitStatus = getDuffelCircuitStatus;
// [HEALTH-CHECK-ISOLATION] duffelAttempt بيعمل نفس الطلب (بحماية
// timeout) بس من غير ما يسجّل نجاح/فشل على الـ circuit breaker
// المشترك — مخصص لأدوات التشخيص الإدارية (زي فحص صحة المسارات) اللي
// طبيعي جداً تقابل مسارات فاضية أو أخطاء متكررة، وده مش لازم يتفسّر
// كـ"Duffel واقع" ويوقف الخدمة عن العملاء الحقيقيين اللي بيدوروا في
// نفس اللحظة.
module.exports.duffelAttempt = duffelAttempt;
