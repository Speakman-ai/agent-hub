import { mkdirSync, writeFileSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// Per-FILE isolation. vitest invokes setupFiles before each test file is
// imported, so by overriding AGENT_HUB_DATA_DIR to a fresh random subdir
// here, every test file's first import of server/config.ts (which reads
// the env var at module load) sees a unique on-disk location. This is
// what lets `pool: 'forks'` + `isolate: true` run in parallel without
// leaking SQLite databases, projects.json, auth.json, etc. across files.
//
// Note: vitest forks reuse OS processes across files within a worker,
// so process.pid is NOT unique per file. The randomUUID subdir below is.
//
// vitest.config.ts seeded AGENT_HUB_DATA_DIR to a per-process base under
// os.tmpdir() — we nest one more level under it so cleanup is bounded and
// the safety rail in server/config.ts (which refuses to run tests pointing
// at the production data dir) still passes.
const BASE_DIR =
  process.env.AGENT_HUB_DATA_DIR ?? path.join(os.tmpdir(), `agent-hub-test-${process.pid}`);
const TEST_DATA_DIR = path.join(BASE_DIR, `file-${crypto.randomUUID()}`);

// Defence-in-depth: never let a test write outside os.tmpdir().
if (!TEST_DATA_DIR.startsWith(os.tmpdir())) {
  throw new Error(
    `[test/setup] AGENT_HUB_DATA_DIR must live under ${os.tmpdir()} for tests. Got: ${TEST_DATA_DIR}`,
  );
}

// Override BEFORE the test file body imports anything from server/.
process.env.AGENT_HUB_DATA_DIR = TEST_DATA_DIR;
delete process.env.AGENT_HUB_API_KEY;

mkdirSync(TEST_DATA_DIR, { recursive: true });
writeFileSync(path.join(TEST_DATA_DIR, 'projects.json'), '[]');

afterAll(() => {
  try {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
});
