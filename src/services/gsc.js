// ═══════════════════════════════════════════════════════════════
// src/services/gsc.js
// [GSC-OAUTH] Google Search Console connection via OAuth 2.0. Chosen over a
// service account because the org policy blocks service-account key creation;
// OAuth needs no SA key. Everything here runs server-side (Render): the OAuth
// client secret and the stored refresh token NEVER reach the browser.
//
// Flow: buildAuthUrl() (admin, via the app) → Google consent → handleCallback()
// stores the refresh_token in admin_config → fetchSearchAnalytics() uses it to
// pull the REAL Pages/Queries performance data. Read-only scope.
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const env = require('../config/env');
const log = require('../utils/log');
const { getAdminConfig, setAdminConfig } = require('./adminConfig');

const CONFIG_KEY = 'gsc_oauth';          // { refresh_token, connected_at, by, site_url }
const PENDING_KEY = 'gsc_oauth_pending'; // { state, created_at, by }  (short-lived CSRF token)
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GSC_API = 'https://searchconsole.googleapis.com/webmasters/v3';
const STATE_TTL_MS = 10 * 60 * 1000;

function isConfigured() {
  return !!(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.GOOGLE_OAUTH_REDIRECT_URI);
}

function siteUrl() { return env.GSC_SITE_URL || 'sc-domain:airpiv.com'; }

async function getConnection() {
  const cfg = await getAdminConfig(CONFIG_KEY, null);
  return cfg && cfg.refresh_token ? cfg : null;
}

// Build the Google consent URL and stash a one-time `state` for CSRF protection
// (the callback can't carry the admin cookie, so state ties it to this request).
async function buildAuthUrl(connectedBy) {
  if (!isConfigured()) throw Object.assign(new Error('GSC OAuth ist nicht konfiguriert (GOOGLE_OAUTH_* fehlen)'), { status: 503 });
  const state = crypto.randomBytes(16).toString('hex');
  await setAdminConfig(PENDING_KEY, { state, created_at: Date.now(), by: connectedBy || null });
  const params = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',   // ask for a refresh token
    prompt: 'consent',        // force a refresh token even on re-connect
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

// Exchange the callback code for a refresh token and store it. Verifies the
// one-time state first. Never returns tokens to the caller.
async function handleCallback(code, state) {
  const pending = await getAdminConfig(PENDING_KEY, null);
  if (!pending || !pending.state || pending.state !== state) throw Object.assign(new Error('invalid_state'), { status: 400 });
  if (Date.now() - (pending.created_at || 0) > STATE_TTL_MS) throw Object.assign(new Error('state_expired'), { status: 400 });

  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI,
    grant_type: 'authorization_code',
  });
  const resp = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.refresh_token) {
    throw Object.assign(new Error(json.error_description || json.error || 'token_exchange_failed'), { status: 502 });
  }
  await setAdminConfig(CONFIG_KEY, {
    refresh_token: json.refresh_token,
    connected_at: new Date().toISOString(),
    by: pending.by || null,
    site_url: siteUrl(),
  });
  await setAdminConfig(PENDING_KEY, null);
  return true;
}

// Trade the stored refresh token for a short-lived access token.
async function getAccessToken() {
  const conn = await getConnection();
  if (!conn) throw Object.assign(new Error('not_connected'), { status: 409 });
  const body = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    refresh_token: conn.refresh_token,
    grant_type: 'refresh_token',
  });
  const resp = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.access_token) throw Object.assign(new Error(json.error_description || json.error || 'refresh_failed'), { status: 502 });
  return json.access_token;
}

// Pull real Search Analytics rows (Pages by default, or Queries). Returns raw
// rows { url|query, clicks, impressions, position } — classification happens in
// the frontend's existing report builder, so nothing here fabricates a metric.
async function fetchSearchAnalytics({ type = 'pages', days = 28, rowLimit = 1000 } = {}) {
  const token = await getAccessToken();
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - Math.max(1, Math.min(480, days)));
  const fmt = (d) => d.toISOString().slice(0, 10);
  const dimension = type === 'queries' ? 'query' : 'page';

  const resp = await fetch(`${GSC_API}/sites/${encodeURIComponent(siteUrl())}/searchAnalytics/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ startDate: fmt(start), endDate: fmt(end), dimensions: [dimension], rowLimit: Math.max(1, Math.min(25000, rowLimit)), dataState: 'final' }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw Object.assign(new Error((json.error && json.error.message) || 'gsc_query_failed'), { status: 502 });

  const rows = (json.rows || []).map((r) => {
    const key = r.keys && r.keys[0];
    const base = { clicks: r.clicks == null ? null : r.clicks, impressions: r.impressions == null ? null : r.impressions, position: r.position == null ? null : r.position };
    return dimension === 'page' ? { url: key, ...base } : { query: key, ...base };
  });
  return { rows, dateRange: `${fmt(start)} … ${fmt(end)}`, type: dimension === 'page' ? 'pages' : 'queries' };
}

async function disconnect() {
  await setAdminConfig(CONFIG_KEY, null);
  await setAdminConfig(PENDING_KEY, null);
  log('info', 'gsc_disconnected', {});
}

module.exports = { isConfigured, siteUrl, getConnection, buildAuthUrl, handleCallback, getAccessToken, fetchSearchAnalytics, disconnect };
