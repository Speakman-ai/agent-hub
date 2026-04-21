import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';

// AGENT_HUB_DATA_DIR / AGENT_HUB_TEST_MODE / AGENT_HUB_PORT are set via
// `test.env` in vitest.config.ts so they're present before any module
// loads server/config.ts. Trust that value here; we only use it to create
// the dir on disk + seed projects.json + arrange teardown.
const TEST_DATA_DIR: string =
  process.env.AGENT_HUB_DATA_DIR ?? path.join(os.tmpdir(), `agent-hub-test-${process.pid}`);

// Hard-fail fast if someone imports setup.ts with the env var pointing at
// something that looks like a real home-dir data dir — defence in depth on
// top of the config.ts guard.
if (!TEST_DATA_DIR.startsWith(os.tmpdir())) {
  throw new Error(
    `[test/setup] AGENT_HUB_DATA_DIR must live under ${os.tmpdir()} for tests. Got: ${TEST_DATA_DIR}`,
  );
}

delete process.env.AGENT_HUB_API_KEY;

mkdirSync(TEST_DATA_DIR, { recursive: true });
if (!existsSync(path.join(TEST_DATA_DIR, 'projects.json'))) {
  writeFileSync(path.join(TEST_DATA_DIR, 'projects.json'), '[]');
}

afterAll(() => {
  try {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
});
