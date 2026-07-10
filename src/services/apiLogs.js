// ═══════════════════════════════════════════════════════════════
// src/services/apiLogs.js
// [API-COST-MONITORING] سجل خفيف لكل نداء منطقي لـ Duffel — مصدر
// بيانات لوحة مراقبة الـ API الإدارية. Fire-and-forget بالكامل، زي
// error_logs في utils/log.js — أبداً ميوقفش أو يبطّئ الطلب الحقيقي
// اللي العميل مستني رده.
// ═══════════════════════════════════════════════════════════════

const supa = require('../clients/supabase');
const log = require('../utils/log');

function categorizeEndpoint(path) {
  const p = String(path || '');
  if (p.startsWith('/air/offer_requests')) return 'search';
  if (p.startsWith('/air/orders')) return 'booking';
  return 'other';
}

function recordApiLog({ method, path, statusCode, success, durationMs, logContext }) {
  if (!supa) return;
  try {
    supa.from('api_logs').insert({
      method,
      endpoint: path,
      category: categorizeEndpoint(path),
      status_code: statusCode != null ? statusCode : null,
      success: !!success,
      duration_ms: durationMs != null ? durationMs : null,
      route_origin: (logContext && logContext.route_origin) || null,
      route_destination: (logContext && logContext.route_destination) || null,
    }).then(({ error }) => {
      if (error) log('warn', 'api_log_insert_failed', { error: error.message });
    });
  } catch (e) {
    log('warn', 'api_log_insert_failed', { error: e.message });
  }
}

module.exports = { categorizeEndpoint, recordApiLog };
