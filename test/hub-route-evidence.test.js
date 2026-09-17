const fs = require('fs');
const path = require('path');

describe('hub route evidence selector parity', () => {
  test('hub route selectors include every field used by routeIndexable evidence/demand/freshness policy', () => {
    const contentRoutes = fs.readFileSync(
      path.join(__dirname, '../src/routes/content.routes.js'),
      'utf8',
    );
    const match = contentRoutes.match(
      /const HUB_ROUTE_EVIDENCE_COLS = '([^']+)'/,
    );

    expect(match).not.toBeNull();

    const selected = new Set(match[1].split(','));
    [
      'avg_duration_min',
      'stop_distribution',
      'price_sample_count',
      'itinerary_count',
      'intro_text',
      'custom_faq',
      'route_score',
      'weekly_flights',
      'insights_updated_at',
    ].forEach((column) => expect(selected.has(column)).toBe(true));
  });
});
