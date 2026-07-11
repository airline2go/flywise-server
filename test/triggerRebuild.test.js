jest.mock('../src/utils/log', () => jest.fn());

describe('triggerRebuild', () => {
  const ORIGINAL_HOOK = process.env.RENDER_DEPLOY_HOOK_URL;
  const ORIGINAL_REVALIDATE_URL = process.env.NEXTJS_REVALIDATE_URL;
  const ORIGINAL_REVALIDATE_SECRET = process.env.NEXTJS_REVALIDATE_SECRET;
  let originalFetch;

  beforeEach(() => {
    jest.resetModules();
    originalFetch = global.fetch;
    global.fetch = jest.fn();
  });

  afterEach(() => {
    process.env.RENDER_DEPLOY_HOOK_URL = ORIGINAL_HOOK;
    process.env.NEXTJS_REVALIDATE_URL = ORIGINAL_REVALIDATE_URL;
    process.env.NEXTJS_REVALIDATE_SECRET = ORIGINAL_REVALIDATE_SECRET;
    global.fetch = originalFetch;
  });

  test('does nothing when neither RENDER_DEPLOY_HOOK_URL nor NEXTJS_REVALIDATE_URL is set', () => {
    delete process.env.RENDER_DEPLOY_HOOK_URL;
    delete process.env.NEXTJS_REVALIDATE_URL;
    delete process.env.NEXTJS_REVALIDATE_SECRET;
    const triggerRebuild = require('../src/utils/triggerRebuild');
    triggerRebuild([{ type: 'route', slug: 'muc-pmi' }]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('POSTs to the deploy hook URL when configured', () => {
    process.env.RENDER_DEPLOY_HOOK_URL = 'https://api.render.com/deploy/srv-fake?key=abc';
    delete process.env.NEXTJS_REVALIDATE_URL;
    global.fetch.mockResolvedValue({ ok: true });
    const triggerRebuild = require('../src/utils/triggerRebuild');
    triggerRebuild();
    expect(global.fetch).toHaveBeenCalledWith('https://api.render.com/deploy/srv-fake?key=abc', { method: 'POST' });
  });

  test('a failed hook call is logged as a warning and never throws', async () => {
    process.env.RENDER_DEPLOY_HOOK_URL = 'https://api.render.com/deploy/srv-fake?key=abc';
    delete process.env.NEXTJS_REVALIDATE_URL;
    global.fetch.mockRejectedValue(new Error('network down'));
    const triggerRebuild = require('../src/utils/triggerRebuild');
    const log = require('../src/utils/log');
    expect(() => triggerRebuild()).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(log).toHaveBeenCalledWith('warn', 'frontend_rebuild_trigger_failed', { error: 'network down' });
  });

  test('does not call the revalidate endpoint when no entities are passed, even if configured', () => {
    delete process.env.RENDER_DEPLOY_HOOK_URL;
    process.env.NEXTJS_REVALIDATE_URL = 'https://flywise-web.vercel.app';
    process.env.NEXTJS_REVALIDATE_SECRET = 'shh';
    global.fetch.mockResolvedValue({ ok: true });
    const triggerRebuild = require('../src/utils/triggerRebuild');
    triggerRebuild();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('POSTs the entities payload to /api/revalidate with the bearer secret when configured', () => {
    delete process.env.RENDER_DEPLOY_HOOK_URL;
    process.env.NEXTJS_REVALIDATE_URL = 'https://flywise-web.vercel.app';
    process.env.NEXTJS_REVALIDATE_SECRET = 'shh';
    global.fetch.mockResolvedValue({ ok: true });
    const triggerRebuild = require('../src/utils/triggerRebuild');
    triggerRebuild([{ type: 'route', slug: 'muc-pmi' }, { type: 'city', slug: 'munich' }]);
    expect(global.fetch).toHaveBeenCalledWith('https://flywise-web.vercel.app/api/revalidate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer shh' },
      body: JSON.stringify({ entities: [{ type: 'route', slug: 'muc-pmi' }, { type: 'city', slug: 'munich' }] }),
    });
  });

  test('fires both the deploy hook and the revalidate call when both are configured', () => {
    process.env.RENDER_DEPLOY_HOOK_URL = 'https://api.render.com/deploy/srv-fake?key=abc';
    process.env.NEXTJS_REVALIDATE_URL = 'https://flywise-web.vercel.app';
    process.env.NEXTJS_REVALIDATE_SECRET = 'shh';
    global.fetch.mockResolvedValue({ ok: true });
    const triggerRebuild = require('../src/utils/triggerRebuild');
    triggerRebuild([{ type: 'blog', slug: 'my-post', lang: 'de' }]);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenCalledWith('https://api.render.com/deploy/srv-fake?key=abc', { method: 'POST' });
    expect(global.fetch).toHaveBeenCalledWith('https://flywise-web.vercel.app/api/revalidate', expect.objectContaining({ method: 'POST' }));
  });

  test('a failed revalidate call is logged as a warning and never throws', async () => {
    delete process.env.RENDER_DEPLOY_HOOK_URL;
    process.env.NEXTJS_REVALIDATE_URL = 'https://flywise-web.vercel.app';
    process.env.NEXTJS_REVALIDATE_SECRET = 'shh';
    global.fetch.mockRejectedValue(new Error('network down'));
    const triggerRebuild = require('../src/utils/triggerRebuild');
    const log = require('../src/utils/log');
    expect(() => triggerRebuild([{ type: 'route', slug: 'muc-pmi' }])).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(log).toHaveBeenCalledWith('warn', 'nextjs_revalidate_trigger_failed', { error: 'network down' });
  });
});
