describe('Duffel usage alert thresholds', () => {
  test('uses conservative hourly and daily thresholds', () => {
    jest.resetModules();
    jest.mock('../src/config/env', () => ({ NODE_ENV: 'test', BREVO_API_KEY: '', SUPPORT_EMAIL: '' }));
    jest.mock('../src/clients/redis', () => null);
    jest.mock('../src/utils/log', () => jest.fn());
    const { HOURLY_THRESHOLD, DAILY_THRESHOLD } = require('../src/services/duffelUsageAlert');
    expect(HOURLY_THRESHOLD).toBe(100);
    expect(DAILY_THRESHOLD).toBe(1000);
  });
});
