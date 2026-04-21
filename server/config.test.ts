/**
 * Guards the hard safety rail added after a data-loss incident in
 * ~/.agent-hub/data/agent-hub.db where six `designs` rows were deleted by
 * server/designs-store.test.ts' bulk-wipe beforeEach running against the
 * production DB. Root cause: `AGENT_HUB_DATA_DIR` was set in test/setup.ts
 * (after module load) rather than vitest.config.ts test.env (before module
 * load). config.ts now refuses to boot in test mode when the resolved data
 * dir equals the production default.
 *
 * These tests import config.ts fresh per case via vi.resetModules().
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const originalEnv = { ...process.env };
const PRODUCTION_DEFAULT = path.join(os.homedir(), '.agent-hub', 'data');

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

afterEach(() => {
  resetEnv();
  vi.resetModules();
});

describe('config.ts — TEST_MODE safety rail', () => {
  it('throws when AGENT_HUB_TEST_MODE=1 and AGENT_HUB_DATA_DIR is unset', async () => {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    delete process.env.AGENT_HUB_DATA_DIR;

    await expect(import('./config.js')).rejects.toThrow(
      /TEST_MODE=1 but AGENT_HUB_DATA_DIR resolves to the production default/,
    );
  });

  it('throws when AGENT_HUB_TEST_MODE=1 and AGENT_HUB_DATA_DIR explicitly equals production default', async () => {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    process.env.AGENT_HUB_DATA_DIR = PRODUCTION_DEFAULT;

    await expect(import('./config.js')).rejects.toThrow(
      /TEST_MODE=1 but AGENT_HUB_DATA_DIR resolves to the production default/,
    );
  });

  it('loads cleanly when AGENT_HUB_TEST_MODE=1 and AGENT_HUB_DATA_DIR points at a tmp dir', async () => {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    process.env.AGENT_HUB_DATA_DIR = path.join(os.tmpdir(), `agent-hub-guard-ok-${process.pid}`);

    const mod = await import('./config.js');
    expect(mod.default.dataDir).toBe(process.env.AGENT_HUB_DATA_DIR);
  });

  it('does NOT throw in production (TEST_MODE unset) even when dataDir is the default', async () => {
    vi.resetModules();
    delete process.env.AGENT_HUB_TEST_MODE;
    delete process.env.AGENT_HUB_DATA_DIR;

    const mod = await import('./config.js');
    expect(mod.default.dataDir).toBe(PRODUCTION_DEFAULT);
  });
});

describe('config.ts ↔ Terraform install parity', () => {
  // Guards the coupling between the server's cursorBin default and the
  // provisioning step in ops/terraform/main.tf that installs the Cursor CLI
  // and symlinks it into /usr/local/bin/agent. If someone flips one without
  // the other, sessions with engine=cursor-agent fail to spawn on freshly
  // provisioned EC2 boxes with a cryptic ENOENT — this test catches it early.
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const terraformMain = path.resolve(__dirname, '..', 'ops', 'terraform', 'main.tf');

  it('cursorBin default matches the symlink created by Terraform user_data', async () => {
    vi.resetModules();
    // Point the config loader at an isolated tmp dir so a developer's local
    // ~/.agent-hub/data/config.json with a `cursorBin` override does not
    // fail this test for reasons unrelated to the Terraform/default coupling.
    process.env.AGENT_HUB_TEST_MODE = '1';
    process.env.AGENT_HUB_DATA_DIR = path.join(
      os.tmpdir(),
      `agent-hub-cursor-parity-${process.pid}`,
    );
    delete process.env.CURSOR_BIN;

    const mod = await import('./config.js');
    expect(mod.default.cursorBin).toBe('/usr/local/bin/agent');

    const tf = fs.readFileSync(terraformMain, 'utf8');
    expect(tf).toMatch(/https:\/\/cursor\.com\/install/);
    expect(tf).toMatch(/\/usr\/local\/bin\/agent/);
  });
});
