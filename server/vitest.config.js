import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['**/*.test.js'],
    // Use the test setup file for global hooks
    setupFiles: ['./test/setup.js'],
    // Run tests sequentially — they share the same Express app + SQLite DB
    sequence: { concurrent: false },
    fileParallelism: false,
    // Generous timeout for slow CI environments
    testTimeout: 15000,
    // Environment variables for test mode
    env: {
      AGENT_HUB_TEST_MODE: '1',
      AGENT_HUB_PORT: '0', // supertest picks a random port
    },
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['*.js'],
      exclude: ['index.js', 'vitest.config.js', '**/*.test.js'],
    },
  },
});
