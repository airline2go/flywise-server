import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals:     true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include:  ['routes/**', 'middleware/**', 'services/**', 'validators/**', 'utils/**'],
      exclude:  ['utils/logger.js'],       // pino transport hard to mock
    },
    // Prevent tests from actually starting the HTTP server
    testTimeout: 10_000,
  },
});
