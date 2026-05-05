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
    // Starter template payloads ship their own test files that are only
    // valid inside a scaffolded project (they expect the template's own
    // devDependencies, not the server's). Keep them out of the server
    // test run.
    exclude: ['**/node_modules/**', 'provisioning/templates/*/files/**'],
    setupFiles: ['./test/setup.ts'],
    // File-level parallelism is ON. Each test file gets a fresh random subdir
    // under TEST_DATA_DIR (set in test/setup.ts before any server module
    // loads), so SQLite files / projects.json / auth.json / etc. never leak
    // across files. `isolate: true` (Vitest's default for `pool: 'forks'`)
    // reloads the module graph per file so config.ts re-reads
    // AGENT_HUB_DATA_DIR after setup.ts has redirected it. See
    // `feature/test-suite-slim-down` for the original turn-on PR.
    sequence: { concurrent: false },
    pool: 'forks',
    isolate: true,
    testTimeout: 15000,
    // Server initialization (index.ts import) takes longer than vitest's
    // default hookTimeout of 10 s on cold starts (DB init, skill sync, etc.)
    // causing beforeAll hooks in isolated test runs to fail. 30 s matches
    // the explicit 60 s override used by the oldest test file (api.test.ts)
    // and keeps isolated runs stable without inflating the full-suite wall time.
    hookTimeout: 30000,
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
