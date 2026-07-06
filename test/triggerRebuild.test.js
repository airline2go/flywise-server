jest.mock('../src/utils/log', () => jest.fn());

describe('triggerRebuild', () => {
  const ORIGINAL_ENV = process.env.RENDER_DEPLOY_HOOK_URL;
  let originalFetch;

  beforeEach(() => {
    jest.resetModules();
    originalFetch = global.fetch;
    global.fetch = jest.fn();
  });

  afterEach(() => {
    process.env.RENDER_DEPLOY_HOOK_URL = ORIGINAL_ENV;
    global.fetch = originalFetch;
  });

  test('does nothing when RENDER_DEPLOY_HOOK_URL is not set', () => {
    delete process.env.RENDER_DEPLOY_HOOK_URL;
    const triggerRebuild = require('../src/utils/triggerRebuild');
    triggerRebuild();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('POSTs to the deploy hook URL when configured', () => {
    process.env.RENDER_DEPLOY_HOOK_URL = 'https://api.render.com/deploy/srv-fake?key=abc';
    global.fetch.mockResolvedValue({ ok: true });
    const triggerRebuild = require('../src/utils/triggerRebuild');
    triggerRebuild();
    expect(global.fetch).toHaveBeenCalledWith('https://api.render.com/deploy/srv-fake?key=abc', { method: 'POST' });
  });

  test('a failed hook call is logged as a warning and never throws', async () => {
    process.env.RENDER_DEPLOY_HOOK_URL = 'https://api.render.com/deploy/srv-fake?key=abc';
    global.fetch.mockRejectedValue(new Error('network down'));
    const triggerRebuild = require('../src/utils/triggerRebuild');
    const log = require('../src/utils/log');
    expect(() => triggerRebuild()).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(log).toHaveBeenCalledWith('warn', 'frontend_rebuild_trigger_failed', { error: 'network down' });
  });
});
