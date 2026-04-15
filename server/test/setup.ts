import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';

const TEST_DATA_DIR: string = path.join(os.tmpdir(), `agent-hub-test-${process.pid}`);

process.env.AGENT_HUB_TEST_MODE = '1';
process.env.AGENT_HUB_DATA_DIR = TEST_DATA_DIR;
process.env.AGENT_HUB_PORT = '0';
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
