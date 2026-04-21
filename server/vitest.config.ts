import { defineConfig } from 'vitest/config';
import os from 'os';
import path from 'path';

// Compute a per-process tmp data dir at config-load time so the env var is
// present BEFORE any test module imports server/config.ts (which reads
// AGENT_HUB_DATA_DIR at module load). Setting this inside test/setup.ts was
// insufficient and caused a data-loss incident — see PR feature/designs-wipe-guard.
const TEST_DATA_DIR = path.join(os.tmpdir(), `agent-hub-test-${process.pid}`);

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
      AGENT_HUB_DATA_DIR: TEST_DATA_DIR,
    },
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['*.ts'],
      exclude: ['index.ts', 'vitest.config.ts', '**/*.test.ts'],
    },
  },
});
