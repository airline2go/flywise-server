#!/usr/bin/env node

// ═══════════════════════════════════════════════════════════════════════════
// CLI script to generate SEO content for all published route pages.
// Usage: node src/cli/generate-seo-content.js [--dry-run] [--route-id=<id>]
// ═══════════════════════════════════════════════════════════════════════════

const env = require('../config/env');
const supa = require('../clients/supabase');
const log = require('../utils/log');
const {
  processRoutes,
  generateStatistics,
  processSingleRoute,
  SUPPORTED_LANGUAGES
} = require('../services/seoBatchProcessor');

// Parse command line arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const routeId = args.find(arg => arg.startsWith('--route-id='))?.split('=')[1];
const listOnly = args.includes('--list');
const statsOnly = args.includes('--stats');

async function main() {
  try {
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║        SEO CONTENT GENERATION FOR FLIGHT ROUTES            ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    // Show statistics
    if (statsOnly || !routeId) {
      console.log('📊 Analyzing pages...\n');
      const stats = await generateStatistics();
      console.log('Statistics:');
      console.log(`  Total published routes:    ${stats.total_routes}`);
      console.log(`  With manual SEO content:   ${stats.with_manual_seo}`);
      console.log(`  Ready for generation:      ${stats.without_manual_seo}`);
      console.log(`  Supported languages:       ${stats.languages_supported}\n`);

      if (statsOnly) {
        console.log('✅ Statistics generated. Use --batch to generate content.\n');
        process.exit(0);
      }
    }

    // Single route processing
    if (routeId) {
      console.log(`🔄 Processing single route (ID: ${routeId})...\n`);
      for (const lang of SUPPORTED_LANGUAGES) {
        try {
          console.log(`  Generating content for ${lang.toUpperCase()}...`);
          await processSingleRoute(routeId, lang);
          console.log(`  ✓ ${lang.toUpperCase()} completed`);
        } catch (err) {
          console.log(`  ✗ ${lang.toUpperCase()} failed: ${err.message}`);
        }
      }
      console.log('\n✅ Single route processing completed.\n');
      process.exit(0);
    }

    // Batch processing
    if (dryRun) {
      console.log('🏃 DRY RUN MODE - No changes will be saved\n');
    } else {
      console.log('🏃 BATCH PROCESSING MODE - Generating content for all routes\n');
    }

    console.log('Starting batch generation...\n');

    let lastUpdate = Date.now();
    const results = await new Promise((resolve, reject) => {
      processRoutes((progress) => {
        const now = Date.now();
        // Update every 2 seconds to avoid log spam
        if (now - lastUpdate > 2000 || progress.processed === progress.total) {
          const pct = Math.round((progress.processed / progress.total) * 100);
          const bar = '█'.repeat(Math.floor(pct / 2)) + '░'.repeat(50 - Math.floor(pct / 2));
          console.log(`[${bar}] ${progress.processed}/${progress.total} (${pct}%)`);
          console.log(`   Current: ${progress.current}`);
          console.log(`   Updated: ${progress.updated} | Failed: ${progress.failed}\n`);
          lastUpdate = now;
        }
      }).then(resolve).catch(reject);
    });

    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║                    GENERATION COMPLETE                     ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    console.log('Summary:');
    console.log(`  Total processed:  ${results.processed}`);
    console.log(`  Successfully updated: ${results.updated}`);
    console.log(`  Failed:           ${results.failed}`);
    console.log(`  Skipped (manual content): ${results.total - results.processed}\n`);

    if (results.failed > 0) {
      console.log('⚠️  Some routes failed to process. Check server logs for details.\n');
    } else {
      console.log('✅ All routes processed successfully!\n');
    }

    process.exit(results.failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('\n❌ Fatal error:\n', err.message);
    process.exit(1);
  }
}

// Show help
if (args.includes('--help')) {
  console.log(`
Usage: node src/cli/generate-seo-content.js [options]

Options:
  --stats              Show statistics only, don't process
  --route-id=<id>      Generate content for a specific route
  --dry-run            Show what would be generated without saving
  --list               List all routes ready for generation
  --help               Show this help message

Examples:
  # Show statistics
  node src/cli/generate-seo-content.js --stats

  # Generate for specific route
  node src/cli/generate-seo-content.js --route-id=abc123def456

  # Batch generate for all routes
  node src/cli/generate-seo-content.js

  # Check results without modifying database
  node src/cli/generate-seo-content.js --dry-run
`);
  process.exit(0);
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
