/**
 * Playwright global teardown — removes the temp data directory.
 */

import { rmSync } from 'fs';
import path from 'path';
import os from 'os';

const DATA_DIR = path.join(os.tmpdir(), 'agent-hub-e2e-data');

export default async function globalTeardown() {
  try {
    rmSync(DATA_DIR, { recursive: true, force: true });
    console.log(`[e2e] Cleaned up: ${DATA_DIR}`);
  } catch {
    // Best-effort cleanup
  }
}
