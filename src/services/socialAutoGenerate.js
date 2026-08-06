// ═══════════════════════════════════════════════════════════════
// src/services/socialAutoGenerate.js
// [SOCIAL-AUTOMATION] Once a day (when enabled), turns the top Content
// Opportunities into draft social posts in the queue — so the Social Studio
// keeps filling itself without anyone opening the admin. Same self-starting
// .unref() pattern as the route*Refresh services; config lives in admin_config.
// ═══════════════════════════════════════════════════════════════

const supa = require('../clients/supabase');
const log = require('../utils/log');
const { getAdminConfig, setAdminConfig } = require('./adminConfig');
const { generateSocialPost } = require('./socialGenerator');

const CONFIG_KEY = 'social_auto_generate';
const LAST_RUN_KEY = 'social_auto_generate_last_run';
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly; a per-day guard limits real runs
const DEFAULT_CONFIG = { enabled: false, platforms: ['instagram'], languages: ['de'], dailyCount: 3 };
const VALID_PLATFORMS = ['facebook', 'instagram', 'x', 'linkedin', 'pinterest', 'threads'];
const VALID_LANGS = ['en', 'de', 'es', 'fr', 'it', 'nl', 'ar'];

function clampCount(n) { return Math.min(Math.max(parseInt(n, 10) || 3, 1), 20); }

async function getConfig() {
  const cfg = (await getAdminConfig(CONFIG_KEY, DEFAULT_CONFIG)) || DEFAULT_CONFIG;
  const platforms = Array.isArray(cfg.platforms) ? cfg.platforms.filter((p) => VALID_PLATFORMS.includes(p)) : [];
  const languages = Array.isArray(cfg.languages) ? cfg.languages.filter((l) => VALID_LANGS.includes(l)) : [];
  return {
    enabled: !!cfg.enabled,
    platforms: platforms.length ? platforms : DEFAULT_CONFIG.platforms,
    languages: languages.length ? languages : DEFAULT_CONFIG.languages,
    dailyCount: clampCount(cfg.dailyCount),
  };
}

async function setConfig(patch = {}) {
  const cur = await getConfig();
  const next = {
    enabled: patch.enabled !== undefined ? !!patch.enabled : cur.enabled,
    platforms: Array.isArray(patch.platforms) ? patch.platforms.filter((p) => VALID_PLATFORMS.includes(p)) : cur.platforms,
    languages: Array.isArray(patch.languages) ? patch.languages.filter((l) => VALID_LANGS.includes(l)) : cur.languages,
    dailyCount: patch.dailyCount !== undefined ? clampCount(patch.dailyCount) : cur.dailyCount,
  };
  if (!next.platforms.length) next.platforms = DEFAULT_CONFIG.platforms;
  if (!next.languages.length) next.languages = DEFAULT_CONFIG.languages;
  await setAdminConfig(CONFIG_KEY, next);
  return next;
}

// Real price with its currency symbol — never invented.
function fmtPrice(v, currency) {
  if (v == null) return '';
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return '';
  const sym = currency === 'EUR' ? '€' : currency === 'USD' ? '$' : currency === 'GBP' ? '£' : (currency || '');
  return sym === '€' ? `${n} €` : `${sym}${n}`;
}

// Generate draft posts from the top opportunities and queue them. `force`
// ignores the enabled flag and the once-per-day guard (used by the "run now"
// admin action).
async function autoGenerateOnce(force = false) {
  if (!supa) return { ok: false, error: 'Datenbank nicht verfügbar' };
  try {
    const cfg = await getConfig();
    if (!force && !cfg.enabled) return { ok: true, created: 0, skipped: 'disabled' };

    const today = new Date().toISOString().slice(0, 10);
    if (!force) {
      const last = await getAdminConfig(LAST_RUN_KEY, null);
      if (last === today) return { ok: true, created: 0, skipped: 'already_ran_today' };
    }

    const { data: opps, error } = await supa.rpc('content_opportunities', { limit_n: cfg.dailyCount });
    if (error) throw new Error(error.message);
    const list = opps || [];

    // Skip routes already auto-posted in the last 14 days, so the queue doesn't
    // repeat the same destination.
    const sinceIso = new Date(Date.now() - 14 * 86400000).toISOString();
    const { data: recent } = await supa.from('social_posts').select('subject_ref').eq('created_by', 'auto').gte('created_at', sinceIso);
    const seen = new Set((recent || []).map((r) => r.subject_ref));

    const rows = [];
    for (const o of list) {
      if (seen.has(o.slug)) continue;
      for (const platform of cfg.platforms) {
        const lang = cfg.languages[0];
        const g = generateSocialPost({
          type: 'flight_deal', platform, lang,
          subject: { type: 'route', slug: o.slug },
          data: {
            origin: o.origin_city, destination: o.destination_city,
            price: fmtPrice(o.recent_price != null ? o.recent_price : o.price_min, o.price_currency),
            directFlight: !!o.direct_flight_available,
            entities: [o.origin_city, o.destination_city].filter(Boolean),
          },
        });
        rows.push({
          status: 'draft', platform: g.platform, language: g.language, template_type: g.type,
          subject_type: 'route', subject_ref: o.slug, title: g.title, body: g.body, hashtags: g.hashtags,
          cta_label: g.ctaLabel, cta_url: g.ctaUrl, image_brief: g.imageBrief, created_by: 'auto',
        });
      }
      seen.add(o.slug);
    }

    let created = 0;
    if (rows.length) {
      const { error: insErr } = await supa.from('social_posts').insert(rows);
      if (insErr) throw new Error(insErr.message);
      created = rows.length;
    }
    await setAdminConfig(LAST_RUN_KEY, today);
    log('info', 'social_auto_generated', { created, force });
    return { ok: true, created };
  } catch (e) {
    log('warn', 'social_auto_generate_failed', { error: e.message });
    return { ok: false, error: e.message };
  }
}

setTimeout(() => { autoGenerateOnce(); }, 120000).unref();
setInterval(() => { autoGenerateOnce(); }, CHECK_INTERVAL_MS).unref();

module.exports = { autoGenerateOnce, getConfig, setConfig };
