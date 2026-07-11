// ═══════════════════════════════════════════════════════════════
// src/utils/triggerRebuild.js
// [AUTO-REBUILD] Fires flywise-app's Render deploy hook whenever
// published content changes, so the SSG build picks up a new/edited/
// removed city, country, airport, route, or blog post without waiting
// for the next code push. Fire-and-forget — a failed trigger must
// never block the admin action that caused it.
//
// [NEXTJS-REVALIDATE] Additionally, when an `entities` payload is passed
// and NEXTJS_REVALIDATE_URL/NEXTJS_REVALIDATE_SECRET are configured,
// calls the Next.js frontend's `/api/revalidate` route so the specific
// affected pages refresh immediately instead of waiting for their
// `revalidate: 3600` window to lapse naturally (Phase 2 of the Next.js
// migration). This is additive — the Render hook above still fires
// regardless, since the old static site remains the front door for
// non-migrated paths until the full domain cutover.
// ═══════════════════════════════════════════════════════════════

const env = require('../config/env');
const log = require('./log');

// entities: optional array of { type: 'city'|'country'|'airport'|'airline'|'route'|'blog', slug }
function triggerRebuild(entities) {
  if (env.RENDER_DEPLOY_HOOK_URL) {
    fetch(env.RENDER_DEPLOY_HOOK_URL, { method: 'POST' })
      .catch((err) => log('warn', 'frontend_rebuild_trigger_failed', { error: err.message }));
  }

  if (env.NEXTJS_REVALIDATE_URL && env.NEXTJS_REVALIDATE_SECRET && entities && entities.length) {
    fetch(`${env.NEXTJS_REVALIDATE_URL}/api/revalidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.NEXTJS_REVALIDATE_SECRET}` },
      body: JSON.stringify({ entities }),
    }).catch((err) => log('warn', 'nextjs_revalidate_trigger_failed', { error: err.message }));
  }
}

module.exports = triggerRebuild;
