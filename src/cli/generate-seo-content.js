#!/usr/bin/env node

require('../config/env');
const { processRoutes, generateStatistics, processSingleRoute, PRIMARY_LANGUAGE } = require('../services/seoBatchProcessor');
const { processLocalizedRoutes, SECONDARY_LANGUAGES } = require('../services/multilingualSeoBatchProcessor');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const routeId = args.find((a) => a.startsWith('--route-id='))?.split('=')[1];
const limitArg = args.find((a) => a.startsWith('--limit='))?.split('=')[1];
const language = args.find((a) => a.startsWith('--language='))?.split('=')[1] || PRIMARY_LANGUAGE;
const allLanguages = args.includes('--all-languages');
const limit = limitArg === undefined ? null : Number(limitArg);
const statsOnly = args.includes('--stats');

if (limitArg !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
  console.error('--limit must be a positive integer'); process.exit(2);
}
if (!['de', ...SECONDARY_LANGUAGES].includes(language)) {
  console.error(`Unsupported language: ${language}`); process.exit(2);
}

if (args.includes('--help')) {
  console.log(`\nUsage: node src/cli/generate-seo-content.js [options]\n\n  --stats                 Show readiness report and exit\n  --route-id=<id>         Generate one German route\n  --language=<lang>       Generate a secondary locale (en/fr/es/it/nl/tr/ar)\n  --all-languages         Generate all seven secondary locales\n  --limit=<n>             Process only the top N routes\n  --dry-run               Preview without database writes\n  --force                 Refresh already generated localized rows\n  --help                  Show this help\n`);
  process.exit(0);
}

function printStats(stats) {
  console.log('Readiness report:');
  console.log(`  Published routes:            ${stats.total_published_routes}`);
  console.log(`  Eligible for generation:     ${stats.eligible_for_generation}`);
  console.log(`  Already generated:           ${stats.already_generated}`);
  console.log(`  Skipped — manual content:    ${stats.skipped_manual_content}`);
  console.log(`  Skipped — insufficient data: ${stats.skipped_insufficient_data}`);
  console.log(`  Languages supported:         ${stats.languages_supported.join(', ')}`);
}

async function runLocalized(lang) {
  console.log(`\n=== Localized SEO: ${lang} ===`);
  const results = await processLocalizedRoutes({ language: lang, limit, dryRun, force, progressCallback: (p) => {
    if (p.processed === p.total || p.processed % 25 === 0) {
      console.log(`${lang}: ${p.processed}/${p.total} updated:${p.updated} skipped:${p.skipped} failed:${p.failed} rejected:${p.qualityRejected}`);
    }
  }});
  console.log(`Summary ${lang}: updated=${results.updated} skipped=${results.skipped} failed=${results.failed} rejected=${results.qualityRejected}`);
  return results;
}

async function main() {
  if (statsOnly) { printStats(await generateStatistics()); return 0; }

  if (allLanguages) {
    const results = [];
    for (const lang of SECONDARY_LANGUAGES) results.push(await runLocalized(lang));
    return results.some((r) => r.failed > 0) ? 1 : 0;
  }

  if (language !== PRIMARY_LANGUAGE) {
    await runLocalized(language);
    return 0;
  }

  if (routeId) {
    const res = await processSingleRoute(routeId, PRIMARY_LANGUAGE, { dryRun, force: true });
    if (res.skipped) { console.log(`SKIPPED — ${res.reasons.join('; ')}`); return 0; }
    console.log(`Generated ${res.content.sections.length} sections and ${res.content.faq.length} FAQ entries.`);
    return 0;
  }

  const results = await processRoutes(null, { dryRun, force, limit });
  console.log(JSON.stringify(results, null, 2));
  return results.failed > 0 ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => { console.error('\nFatal error:', err.message); process.exit(1); });