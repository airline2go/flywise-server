// ═══════════════════════════════════════════════════════════════
// src/utils/triggerRebuild.js
// [AUTO-REBUILD] Fires flywise-app's Render deploy hook whenever
// published content changes, so the SSG build picks up a new/edited/
// removed city, country, airport, route, or blog post without waiting
// for the next code push. Fire-and-forget — a failed trigger must
// never block the admin action that caused it.
// ═══════════════════════════════════════════════════════════════

const env = require('../config/env');
const log = require('./log');

function triggerRebuild() {
  if (!env.RENDER_DEPLOY_HOOK_URL) return;
  fetch(env.RENDER_DEPLOY_HOOK_URL, { method: 'POST' })
    .catch((err) => log('warn', 'frontend_rebuild_trigger_failed', { error: err.message }));
}

module.exports = triggerRebuild;
