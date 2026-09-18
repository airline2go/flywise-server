jest.mock('../src/clients/supabase', () => {
  const rows = [
    { id: 'r1', slug: 'a-b', origin_city: 'A', destination_city: 'B', origin_iata: 'AAA', destination_iata: 'BBB' },
    { id: 'r2', slug: 'c-d', origin_city: 'C', destination_city: 'D', origin_iata: 'CCC', destination_iata: 'DDD' },
    { id: 'r3', slug: 'e-f', origin_city: 'E', destination_city: 'F', origin_iata: 'EEE', destination_iata: 'FFF' },
  ];
  return {
    from: jest.fn(() => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        range: (from) => Promise.resolve({ data: from === 0 ? rows : [], error: null }),
      };
      return builder;
    }),
  };
});

jest.mock('../src/services/seo/engine', () => ({
  supportedLanguages: () => ['de', 'en', 'fr'],
  generateRoutePage: jest.fn((route) => ({
    skipped: false,
    angle: 'price',
    content: {
      title: route.slug + ' | Airpiv',
      metaDescription: 'A valid localized route description for testing bounded batch generation.',
      intro: '<p>Localized route content.</p>',
      faq: [{ question: 'Q?', answer: 'A.' }],
      sections: [{ heading: 'Overview', body: 'Data.' }],
    },
    dataCoverage: {},
  })),
}));

jest.mock('../src/services/seo/quality', () => ({
  validateGeneratedSeo: jest.fn(() => ({ valid: true, reasons: [], metrics: {} })),
}));

jest.mock('../src/services/seo/routePriority', () => ({
  sortRoutesForSeo: jest.fn((routes) => routes),
}));

jest.mock('../src/utils/log', () => jest.fn());

const { processLocalizedRoutes } = require('../src/services/multilingualSeoBatchProcessor');
const { generateRoutePage } = require('../src/services/seo/engine');

describe('processLocalizedRoutes bounded windows', () => {
  beforeEach(() => generateRoutePage.mockClear());

  test('honors offset + limit so successive production batches can advance', async () => {
    const result = await processLocalizedRoutes({
      language: 'fr',
      offset: 1,
      limit: 1,
      dryRun: true,
      force: false,
    });

    expect(result).toMatchObject({ language: 'fr', offset: 1, total: 1, processed: 1, updated: 1, dryRun: true, force: false });
    expect(generateRoutePage).toHaveBeenCalledTimes(1);
    expect(generateRoutePage).toHaveBeenCalledWith(expect.objectContaining({ slug: 'c-d' }), 'fr');
  });

  test('normalizes negative offsets to zero instead of allowing invalid slices', async () => {
    const result = await processLocalizedRoutes({
      language: 'fr',
      offset: -20,
      limit: 1,
      dryRun: true,
    });

    expect(result.offset).toBe(0);
  });
});
