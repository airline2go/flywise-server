#!/usr/bin/env node

// ═══════════════════════════════════════════════════════════════════════════
// CLI: generate quality-gated SEO content for published route pages.
//
// Usage:
//   node src/cli/generate-seo-content.js --stats            # readiness report
//   node src/cli/generate-seo-content.js --route-id=<id>    # one route
//   node src/cli/generate-seo-content.js --dry-run          # preview, no writes
//   node src/cli/generate-seo-content.js                    # generate all
//
// The engine SKIPS routes with manual content or insufficient data — skips are
// reported, not treated as failures.
// ═══════════════════════════════════════════════════════════════════════════

require('../config/env');
const {
  processRoutes,
  generateStatistics,
  processSingleRoute,
  PRIMARY_LANGUAGE,
} = require('../services/seoBatchProcessor');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const routeId = args.find((a) => a.startsWith('--route-id='))?.split('=')[1];
const statsOnly = args.includes('--stats');

if (args.includes('--help')) {
  console.log(`
Usage: node src/cli/generate-seo-content.js [options]

  --stats            Show a readiness report and exit (no writes)
  --route-id=<id>    Generate for a single route
  --dry-run          Preview generated fields without writing to the database
  --help             Show this help

Examples:
  node src/cli/generate-seo-content.js --stats
  node src/cli/generate-seo-content.js --route-id=abc123 --dry-run
  node src/cli/generate-seo-content.js
`);
  process.exit(0);
}

function printStats(stats) {
  console.log('Readiness report:');
  console.log(`  Published routes:            ${stats.total_published_routes}`);
  console.log(`  Eligible for generation:     ${stats.eligible_for_generation}`);
  console.log(`  Skipped — manual content:    ${stats.skipped_manual_content}`);
  console.log(`  Skipped — insufficient data: ${stats.skipped_insufficient_data}`);
  console.log(`  Languages with variant pools: ${stats.languages_supported.join(', ')}`);
  const reasons = Object.entries(stats.skip_reason_breakdown || {});
  if (reasons.length) {
    console.log('\n  Skip reasons:');
    reasons.sort((a, b) => b[1] - a[1]).forEach(([r, n]) => console.log(`    ${n.toString().padStart(5)}  ${r}`));
  }
  console.log('');
}

async function main() {
  console.log('\n=== SEO content generation (quality-gated) ===\n');

  if (statsOnly) {
    printStats(await generateStatistics());
    console.log('Statistics only — no changes made.\n');
    return 0;
  }

  if (routeId) {
    console.log(`Processing single route ${routeId} (${PRIMARY_LANGUAGE})${dryRun ? ' [dry-run]' : ''}...\n`);
    const res = await processSingleRoute(routeId, PRIMARY_LANGUAGE, { dryRun });
    if (res.skipped) {
      console.log(`SKIPPED — ${res.reasons.join('; ')}\n`);
      return 0;
    }
    console.log('Generated content:');
    console.log(`  Title: ${res.content.title}`);
    console.log(`  Meta:  ${res.content.metaDescription}`);
    console.log(`  Intro: ${res.content.intro.slice(0, 120)}...`);
    console.log(`  FAQ:   ${res.content.faq.length} questions`);
    console.log(dryRun ? '\n[dry-run] Nothing written.\n' : `\n${res.updated ? 'Written.' : 'No empty fields to fill.'}\n`);
    return 0;
  }

  console.log(`Batch generation${dryRun ? ' [dry-run]' : ''} — primary language ${PRIMARY_LANGUAGE}\n`);
  let last = 0;
  const results = await processRoutes((p) => {
    const now = Date.now();
    if (now - last > 1500 || p.processed === p.total) {
      const pct = p.total ? Math.round((p.processed / p.total) * 100) : 100;
      const filled = Math.floor(pct / 2);
      const bar = '#'.repeat(filled) + '-'.repeat(50 - filled);
      console.log(`[${bar}] ${p.processed}/${p.total} (${pct}%)  updated:${p.updated} skipped:${p.skipped} failed:${p.failed}`);
      last = now;
    }
  }, { dryRun });

  console.log('\n=== Summary ===');
  console.log(`  Total published:  ${results.total}`);
  console.log(`  Updated:          ${results.updated}${dryRun ? ' (dry-run, not written)' : ''}`);
  console.log(`  Skipped:          ${results.skipped}`);
  console.log(`  Failed:           ${results.failed}`);
  const reasons = Object.entries(results.skipReasons || {});
  if (reasons.length) {
    console.log('\n  Skip reasons:');
    reasons.sort((a, b) => b[1] - a[1]).forEach(([r, n]) => console.log(`    ${n.toString().padStart(5)}  ${r}`));
  }
  console.log('');
  return results.failed > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('\nFatal error:', err.message);
    process.exit(1);
  });
