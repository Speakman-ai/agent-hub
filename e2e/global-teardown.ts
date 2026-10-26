/**
 * Playwright global teardown — removes the temp data directory.
 */

import { rmSync } from 'fs';
import path from 'path';
import os from 'os';

const DATA_DIR = path.join(os.tmpdir(), 'agent-hub-e2e-data');
const AUTH_CACHE = path.join(
  os.tmpdir(),
  `agent-hub-e2e-auth-${Number(process.env.E2E_SERVER_PORT) || 4051}.json`,
);

export default async function globalTeardown() {
  try {
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(AUTH_CACHE, { force: true });
    console.log(`[e2e] Cleaned up: ${DATA_DIR}`);
  } catch {
    // Best-effort cleanup
  }
}
