const fs = require('fs');
const path = require('path');

describe('sitemap demand-gate input parity', () => {
  test('route sitemap and hub selectors include demand fields used by routeIndexable', () => {
    const sitemap = fs.readFileSync(path.join(__dirname, '../src/routes/sitemap.routes.js'), 'utf8');
    const content = fs.readFileSync(path.join(__dirname, '../src/routes/content.routes.js'), 'utf8');

    expect(sitemap).toContain('route_score,weekly_flights');
    expect(content).toContain('route_score,weekly_flights');
  });
});
