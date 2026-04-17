import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['**/*.test.ts', '**/*.test.mjs'],
    setupFiles: ['./test/setup.ts'],
    sequence: { concurrent: false },
    fileParallelism: false,
    testTimeout: 15000,
    env: {
      AGENT_HUB_TEST_MODE: '1',
      AGENT_HUB_PORT: '0',
    },
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['*.ts'],
      exclude: ['index.ts', 'vitest.config.ts', '**/*.test.ts'],
    },
  },
});
