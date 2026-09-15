const env = require('../config/env');
const log = require('../utils/log');
const redis = require('../clients/redis');

const HOURLY_THRESHOLD = 100;
const DAILY_THRESHOLD = 1000;
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

const localState = new Map();

function utcKey(period) {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const hour = now.toISOString().slice(11, 13);
  return period === 'hour' ? `${day}:${hour}` : day;
}

async function increment(key, ttlSeconds) {
  if (redis && redis.status === 'ready') {
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, ttlSeconds);
      return count;
    } catch (_) { /* fall back to local process counter */ }
  }
  const now = Date.now();
  const current = localState.get(key);
  if (!current || current.expiresAt <= now) {
    localState.set(key, { count: 1, expiresAt: now + ttlSeconds * 1000 });
    return 1;
  }
  current.count += 1;
  return current.count;
}

async function shouldAlert(alertKey) {
  const key = `duffel_usage_alerted:${alertKey}`;
  if (redis && redis.status === 'ready') {
    try {
      const claimed = await redis.set(key, '1', 'EX', Math.ceil(ALERT_COOLDOWN_MS / 1000), 'NX');
      return claimed === 'OK';
    } catch (_) { /* local fallback */ }
  }
  const now = Date.now();
  const previous = localState.get(key);
  if (previous && previous.expiresAt > now) return false;
  localState.set(key, { count: 1, expiresAt: now + ALERT_COOLDOWN_MS });
  return true;
}

async function sendAlert(subject, html) {
  if (!env.BREVO_API_KEY || !env.SUPPORT_EMAIL) {
    log('warn', 'duffel_usage_alert_not_configured', { subject });
    return false;
  }
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: env.BREVO_SENDER_NAME, email: env.BREVO_SENDER_EMAIL },
        to: [{ email: env.SUPPORT_EMAIL }],
        subject,
        htmlContent: html,
      }),
    });
    if (!res.ok) {
      log('error', 'duffel_usage_alert_send_failed', { subject, status: res.status });
      return false;
    }
    log('info', 'duffel_usage_alert_sent', { subject, to: env.SUPPORT_EMAIL });
    return true;
  } catch (e) {
    log('error', 'duffel_usage_alert_send_exception', { subject, error: e.message });
    return false;
  }
}

async function recordDuffelAttemptAlert({ source, trigger, endpoint }) {
  if (env.NODE_ENV !== 'production') return;

  const hour = await increment(`duffel_usage:${utcKey('hour')}`, 2 * 60 * 60);
  const day = await increment(`duffel_usage:${utcKey('day')}`, 26 * 60 * 60);

  if (hour === HOURLY_THRESHOLD || day === DAILY_THRESHOLD) {
    const period = hour === HOURLY_THRESHOLD ? 'hour' : 'day';
    const count = period === 'hour' ? hour : day;
    const alertKey = `${period}:${utcKey(period)}`;
    if (!(await shouldAlert(alertKey))) return;
    await sendAlert(
      `⚠️ Airpiv Duffel usage alert: ${count} outbound attempts/${period}`,
      `<h2>⚠️ Duffel usage alert</h2><p>Airpiv recorded <strong>${count}</strong> outbound Duffel attempts in the current UTC ${period}.</p><p>Last attempt: <code>${String(source || 'unknown')}</code> / <code>${String(trigger || 'unknown')}</code> / <code>${String(endpoint || 'unknown')}</code></p><p>Check the Admin Duffel API Monitor immediately.</p>`,
    );
  }
}

module.exports = { recordDuffelAttemptAlert, HOURLY_THRESHOLD, DAILY_THRESHOLD };
