const fs = require('fs');
const path = require('path');

describe('sitemap demand-gate input parity', () => {
  test('route sitemap selector includes demand fields used by routeIndexable', () => {
    const sitemap = fs.readFileSync(path.join(__dirname, '../src/routes/sitemap.routes.js'), 'utf8');
    expect(sitemap).toContain('route_score,weekly_flights');
  });
});
