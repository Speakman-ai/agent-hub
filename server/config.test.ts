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
import os from 'os';
import path from 'path';

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
