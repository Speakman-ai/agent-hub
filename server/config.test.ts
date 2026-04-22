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

describe('config.ts ↔ cursor-agent install parity', () => {
  // Guards the coupling between the server's cursorBin default and the
  // provisioning / deploy steps that install the Cursor CLI. If someone
  // flips one without the other, sessions with engine=cursor-agent fail
  // to spawn on freshly provisioned EC2 boxes with a cryptic ENOENT —
  // this test catches it early.
  //
  // Covers three rollout paths:
  //   1. scripts/ensure-cursor-agent.sh — invoked on every deploy
  //   2. ops/terraform/main.tf user_data — one-time bootstrap
  //   3. The three deploy workflows that call the script
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const repoRoot = path.resolve(__dirname, '..');
  const terraformMain = path.join(repoRoot, 'ops', 'terraform', 'main.tf');
  const installScript = path.join(repoRoot, 'scripts', 'ensure-cursor-agent.sh');

  it('cursorBin default tracks the installer-managed path ($HOME/.local/bin/agent)', async () => {
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
    const expected = path.join(os.homedir(), '.local', 'bin', 'agent');
    expect(mod.default.cursorBin).toBe(expected);
  });

  it('scripts/ensure-cursor-agent.sh references the official installer and the matching bin path', () => {
    const script = fs.readFileSync(installScript, 'utf8');
    expect(script).toMatch(/https:\/\/cursor\.com\/install/);
    expect(script).toMatch(/\.local\/bin\/agent/);
  });

  it('Terraform user_data bootstraps cursor-agent via the official installer', () => {
    const tf = fs.readFileSync(terraformMain, 'utf8');
    expect(tf).toMatch(/https:\/\/cursor\.com\/install/);
  });

  it('all three deploy workflows invoke scripts/ensure-cursor-agent.sh', () => {
    const workflows = [
      path.join(repoRoot, '.github', 'workflows', 'deploy-dev.yml'),
      path.join(repoRoot, '.github', 'workflows', 'deploy-prod-2.yml'),
      path.join(repoRoot, '.github', 'workflows', 'release-prod.yml'),
    ];
    for (const wf of workflows) {
      const body = fs.readFileSync(wf, 'utf8');
      expect(body, `${path.basename(wf)} should invoke ensure-cursor-agent.sh`).toMatch(
        /scripts\/ensure-cursor-agent\.sh/,
      );
    }
  });
});

describe('config.ts — cursor-agent model merge (config.json load path)', () => {
  function writeConfigAndImport(dataDir: string, fileConfig: Record<string, unknown>) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(fileConfig), 'utf8');
  }

  // config.json replaces whole engine* maps (no deep merge) — real files list every engine.
  const nonCursorValid: Record<string, string[]> = {
    'claude-code': ['claude-opus-4-7'],
    'gemini-cli': ['gemini-2.5-pro'],
    'codex-cli': ['gpt-5.3-codex'],
  };
  const nonCursorDefaults: Record<string, string> = {
    'claude-code': 'claude-opus-4-7',
    'gemini-cli': 'gemini-2.5-pro',
    'codex-cli': 'gpt-5.3-codex',
  };

  it('strips legacy Codex/GPT/auto/composer-2-fast IDs to the Hub allowlist', async () => {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    const dataDir = path.join(
      os.tmpdir(),
      `agent-hub-cursor-allowlist-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    process.env.AGENT_HUB_DATA_DIR = dataDir;
    writeConfigAndImport(dataDir, {
      engineValidModels: {
        ...nonCursorValid,
        'cursor-agent': [
          'gpt-5.3-codex-high',
          'gpt-5.3-codex',
          'auto',
          'composer-2-fast',
          'composer-2',
        ],
      },
      engineDefaultModels: { ...nonCursorDefaults, 'cursor-agent': 'composer-2' },
    });

    const mod = await import('./config.js');
    expect(mod.default.engineValidModels['claude-code']).toEqual(['claude-opus-4-7']);
    expect(mod.default.engineValidModels['cursor-agent']).toEqual(['composer-2']);
  });

  it('coerces a stale engineDefaultModels["cursor-agent"] to a value in the filtered list', async () => {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    const dataDir = path.join(
      os.tmpdir(),
      `agent-hub-cursor-default-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    process.env.AGENT_HUB_DATA_DIR = dataDir;
    writeConfigAndImport(dataDir, {
      engineValidModels: {
        ...nonCursorValid,
        'cursor-agent': ['gpt-5.3-codex-high', 'composer-2', 'auto'],
      },
      engineDefaultModels: { ...nonCursorDefaults, 'cursor-agent': 'gpt-5.3-codex-high' },
    });

    const mod = await import('./config.js');
    expect(mod.default.engineValidModels['cursor-agent']).toEqual(['composer-2']);
    expect(mod.default.engineDefaultModels['cursor-agent']).toBe('composer-2');
  });

  it('replaces an all-invalid cursor-agent list with the allowlist and fixes the default', async () => {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    const dataDir = path.join(
      os.tmpdir(),
      `agent-hub-cursor-fallback-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    process.env.AGENT_HUB_DATA_DIR = dataDir;
    writeConfigAndImport(dataDir, {
      engineValidModels: {
        ...nonCursorValid,
        'cursor-agent': ['gpt-5.2', 'auto'],
      },
      engineDefaultModels: { ...nonCursorDefaults, 'cursor-agent': 'auto' },
    });

    const mod = await import('./config.js');
    expect(mod.default.engineValidModels['cursor-agent']).toEqual(['composer-2']);
    expect(mod.default.engineDefaultModels['cursor-agent']).toBe('composer-2');
  });
});
