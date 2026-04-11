/**
 * Global test setup for Agent Hub API tests.
 *
 * - Points the data directory at a temp folder so tests don't touch the real DB
 * - Ensures AGENT_HUB_TEST_MODE is set so server/index.js skips listen()
 * - Imports the app after env vars are configured
 * - Cleans up temp files after tests finish
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { beforeAll, afterAll } from 'vitest';

// ─── Temp data directory ────────────────────────────────────────
const TEST_DATA_DIR = path.join(os.tmpdir(), `agent-hub-test-${process.pid}`);

// Set env vars BEFORE any import of server code
process.env.AGENT_HUB_TEST_MODE = '1';
process.env.AGENT_HUB_DATA_DIR = TEST_DATA_DIR;
process.env.AGENT_HUB_PORT = '0';
// No API key for most tests — auth is disabled
delete process.env.AGENT_HUB_API_KEY;

// Bootstrap the data directory with minimal projects.json
mkdirSync(TEST_DATA_DIR, { recursive: true });
if (!existsSync(path.join(TEST_DATA_DIR, 'projects.json'))) {
  writeFileSync(path.join(TEST_DATA_DIR, 'projects.json'), '[]');
}

afterAll(() => {
  // Clean up temp data directory
  try {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
});
