const {
  BLOG_TARGET_LANGUAGES,
  slugify,
  buildTranslationPrompt,
  parseTranslationResponse,
} = require('../src/services/blogTranslation');

describe('BLOG_TARGET_LANGUAGES', () => {
  test('covers the 7 non-German site languages and never includes German', () => {
    const codes = BLOG_TARGET_LANGUAGES.map((l) => l.code).sort();
    expect(codes).toEqual(['ar', 'en', 'es', 'fr', 'it', 'nl', 'tr']);
    expect(codes).not.toContain('de');
    BLOG_TARGET_LANGUAGES.forEach((l) => expect(typeof l.name).toBe('string'));
  });
});

describe('slugify', () => {
  test('produces ASCII-safe slugs and expands German umlauts', () => {
    expect(slugify('Günstige Flüge buchen')).toBe('guenstige-fluege-buchen');
    expect(slugify('  Hello   World!  ')).toBe('hello-world');
  });
  test('falls back to a random slug when the title has no Latin characters', () => {
    const s = slugify('رحلات رخيصة');
    expect(s).toMatch(/^post-[a-z0-9]+$/);
  });
});

describe('buildTranslationPrompt', () => {
  test('names the target language and forbids touching tags/URLs', () => {
    const p = buildTranslationPrompt('Turkish', 'Titel', 'Meta', '<p>Hallo <a href="/flights/muc-pmi">Flug</a></p>');
    expect(p).toContain('into Turkish');
    expect(p).toContain('preserved EXACTLY unchanged');
    expect(p).toContain('/flights/muc-pmi');
    expect(p).toContain('"content_html"');
  });
});

describe('parseTranslationResponse', () => {
  test('parses a clean JSON reply', () => {
    const r = parseTranslationResponse('{"title":"T","content_html":"<p>x</p>","meta_description":"M"}');
    expect(r).toEqual({ title: 'T', content: '<p>x</p>', meta_description: 'M' });
  });
  test('strips a ```json code fence', () => {
    const r = parseTranslationResponse('```json\n{"title":"T","content_html":"<p>x</p>"}\n```');
    expect(r).toEqual({ title: 'T', content: '<p>x</p>', meta_description: null });
  });
  test('returns null on invalid JSON or missing required fields', () => {
    expect(parseTranslationResponse('not json')).toBeNull();
    expect(parseTranslationResponse('{"title":"only title"}')).toBeNull();
    expect(parseTranslationResponse('')).toBeNull();
    expect(parseTranslationResponse(null)).toBeNull();
  });
});
