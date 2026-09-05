// [P1-2] Revalidation payload helpers: a route change touches its own page plus
// both countries, cities and airports; and many routes collapse to one
// de-duplicated batch payload (never thousands of calls).
const { routeEntities, dedupeEntities } = require('../src/utils/routeEntities');

describe('routeEntities', () => {
  test('includes route + both countries + both cities + both airports', () => {
    const e = routeEntities({
      slug: 'ber-muc', origin_country: 'DE', destination_country: 'DE',
      origin_city_slug: 'berlin', destination_city_slug: 'muenchen',
      origin_iata: 'BER', destination_iata: 'MUC',
    });
    expect(e).toEqual(expect.arrayContaining([
      { type: 'route', slug: 'ber-muc' },
      { type: 'country', slug: 'DE' },
      { type: 'city', slug: 'berlin' },
      { type: 'city', slug: 'muenchen' },
      { type: 'airport', slug: 'BER' },
      { type: 'airport', slug: 'MUC' },
    ]));
  });
  test('omits absent fields without throwing', () => {
    expect(routeEntities({ slug: 'x-y' })).toEqual([{ type: 'route', slug: 'x-y' }]);
  });
});

describe('dedupeEntities', () => {
  test('collapses overlapping entities across routes into one payload', () => {
    const a = routeEntities({ slug: 'ber-muc', origin_city_slug: 'berlin', destination_city_slug: 'muenchen', origin_iata: 'BER', destination_iata: 'MUC', origin_country: 'DE', destination_country: 'DE' });
    const b = routeEntities({ slug: 'ber-cgn', origin_city_slug: 'berlin', destination_city_slug: 'koeln', origin_iata: 'BER', destination_iata: 'CGN', origin_country: 'DE', destination_country: 'DE' });
    const merged = dedupeEntities([a, b]);
    // berlin, BER, DE appear once each despite being in both routes.
    expect(merged.filter((e) => e.type === 'city' && e.slug === 'berlin')).toHaveLength(1);
    expect(merged.filter((e) => e.type === 'airport' && e.slug === 'BER')).toHaveLength(1);
    expect(merged.filter((e) => e.type === 'country' && e.slug === 'DE')).toHaveLength(1);
    // both distinct routes survive.
    expect(merged).toEqual(expect.arrayContaining([
      { type: 'route', slug: 'ber-muc' }, { type: 'route', slug: 'ber-cgn' },
    ]));
  });
  test('handles empty / junk safely', () => {
    expect(dedupeEntities([])).toEqual([]);
    expect(dedupeEntities([[null, { type: 'route' }, { slug: 'x' }]])).toEqual([]);
  });
});
