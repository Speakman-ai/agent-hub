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

describe('config.ts ↔ cursor-agent + codex CLI install parity', () => {
  // Guards coupling between server defaults / spawn paths and provisioning that
  // installs Cursor Agent + Codex on EC2 (ENOENT on missing CLIs).
  //
  // Rollout paths:
  //   1. scripts/ensure-cursor-agent.sh + scripts/ensure-codex.sh — deploy workflows
  //   2. ops/terraform/bootstrap*.sh.tftpl + agent-hub-user-data.tftpl
  //   3. GitHub deploy workflows (SSM inner script)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const repoRoot = path.resolve(__dirname, '..');
  const terraformBootstrapDocker = path.join(repoRoot, 'ops', 'terraform', 'bootstrap.sh.tftpl');
  const terraformBootstrapMinimal = path.join(
    repoRoot,
    'ops',
    'terraform',
    'bootstrap-minimal.sh.tftpl',
  );
  const installScript = path.join(repoRoot, 'scripts', 'ensure-cursor-agent.sh');
  const codexInstallScript = path.join(repoRoot, 'scripts', 'ensure-codex.sh');
  const userDataTpl = path.join(repoRoot, 'ops', 'terraform', 'agent-hub-user-data.tftpl');

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
    const dockerTpl = fs.readFileSync(terraformBootstrapDocker, 'utf8');
    const minimalTpl = fs.readFileSync(terraformBootstrapMinimal, 'utf8');
    const installerRe = /https:\/\/cursor\.com\/install/;
    expect(dockerTpl).toMatch(installerRe);
    expect(minimalTpl).toMatch(installerRe);
  });

  it('Terraform bootstrap templates install @openai/codex on the host', () => {
    const dockerTpl = fs.readFileSync(terraformBootstrapDocker, 'utf8');
    const minimalTpl = fs.readFileSync(terraformBootstrapMinimal, 'utf8');
    const ud = fs.readFileSync(userDataTpl, 'utf8');
    const codexRe = /npm\s+install\s+-g\s+@openai\/codex/;
    expect(dockerTpl).toMatch(codexRe);
    expect(minimalTpl).toMatch(codexRe);
    expect(ud).toMatch(codexRe);
  });

  it('scripts/ensure-codex.sh installs via npm and symlinks into ~/.local/bin', () => {
    const script = fs.readFileSync(codexInstallScript, 'utf8');
    expect(script).toMatch(/@openai\/codex/);
    expect(script).toMatch(/\.local\/bin\/codex/);
  });

  it('Terraform agent-hub-user-data invokes ensure-codex on PM2 bootstrap', () => {
    const ud = fs.readFileSync(userDataTpl, 'utf8');
    expect(ud).toMatch(/ensure-codex\.sh/);
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
      expect(body, `${path.basename(wf)} should invoke ensure-codex.sh`).toMatch(
        /scripts\/ensure-codex\.sh/,
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

describe('config.ts — CLI binary auto-detection (pickBin)', () => {
  // Use an isolated tmp data dir so a developer's local
  // ~/.agent-hub/data/config.json overrides cannot influence these tests.
  function freshDataDir(label: string): string {
    return path.join(
      os.tmpdir(),
      `agent-hub-pickbin-${label}-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
  }

  it('findBinaryInDirs returns the first existing path.join(dir, name)', async () => {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    process.env.AGENT_HUB_DATA_DIR = freshDataDir('finddirs');

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-finddirs-'));
    const dirA = path.join(tmpRoot, 'a');
    const dirB = path.join(tmpRoot, 'b');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirB, 'mybin'), '#!/bin/sh\n', { mode: 0o755 });

    const mod = await import('./config.js');
    expect(mod.findBinaryInDirs('mybin', [dirA, dirB])).toBe(path.join(dirB, 'mybin'));
    expect(mod.findBinaryInDirs('mybin', [dirA])).toBeNull();
    // Empty/falsy dirs are skipped without throwing.
    expect(mod.findBinaryInDirs('mybin', ['', dirB])).toBe(path.join(dirB, 'mybin'));

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('pickBin honors a valid env override above everything else', async () => {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    process.env.AGENT_HUB_DATA_DIR = freshDataDir('envwins');

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-envwins-'));
    const envBin = path.join(tmpRoot, 'env-claude');
    const onPathDir = path.join(tmpRoot, 'pathdir');
    fs.mkdirSync(onPathDir, { recursive: true });
    fs.writeFileSync(envBin, '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(onPathDir, 'claude'), '#!/bin/sh\n', { mode: 0o755 });

    process.env.MY_TEST_BIN = envBin;
    process.env.PATH = `${onPathDir}:${process.env.PATH ?? ''}`;

    const mod = await import('./config.js');
    expect(mod.pickBin('claude', 'MY_TEST_BIN', 'claudeBin', '/should/not/use')).toBe(envBin);

    delete process.env.MY_TEST_BIN;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('pickBin falls back to PATH walk when env/config are unset', async () => {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    process.env.AGENT_HUB_DATA_DIR = freshDataDir('pathwalk');

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-pathwalk-'));
    const pathDir = path.join(tmpRoot, 'pathdir');
    fs.mkdirSync(pathDir, { recursive: true });
    const expected = path.join(pathDir, 'walkbin');
    fs.writeFileSync(expected, '#!/bin/sh\n', { mode: 0o755 });

    delete process.env.MY_WALKBIN;
    process.env.PATH = `${pathDir}:${process.env.PATH ?? ''}`;

    const mod = await import('./config.js');
    expect(mod.pickBin('walkbin', 'MY_WALKBIN', 'walkbinBin', '/should/not/use')).toBe(expected);

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('pickBin returns the static fallback when nothing is found anywhere', async () => {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    process.env.AGENT_HUB_DATA_DIR = freshDataDir('fallback');

    delete process.env.NEVER_BIN;
    // Use a binary name guaranteed not to exist on PATH or in common dirs.
    const garbageName = `nonexistent-binary-${Math.random().toString(36).slice(2)}`;
    const fallback = '/var/lib/should-not-exist';

    const mod = await import('./config.js');
    expect(mod.pickBin(garbageName, 'NEVER_BIN', 'neverBin', fallback)).toBe(fallback);
  });

  it('pickBin warns and continues searching when a configured path no longer exists', async () => {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    process.env.AGENT_HUB_DATA_DIR = freshDataDir('staleconfig');

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-staleconfig-'));
    const pathDir = path.join(tmpRoot, 'pathdir');
    fs.mkdirSync(pathDir, { recursive: true });
    const realBin = path.join(pathDir, 'gemini');
    fs.writeFileSync(realBin, '#!/bin/sh\n', { mode: 0o755 });

    process.env.STALE_BIN = '/this/path/does/not/exist/gemini';
    process.env.PATH = `${pathDir}:${process.env.PATH ?? ''}`;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const mod = await import('./config.js');
    expect(mod.pickBin('gemini', 'STALE_BIN', 'geminiBin', '/should/not/use')).toBe(realBin);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('geminiBin'));

    warn.mockRestore();
    delete process.env.STALE_BIN;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });
});

describe('normalizedHttpOriginForAgentHub + normalizedHttpSpawnBaseForAgentHub + resolveAgentHubApiBaseForSpawn', () => {
  async function loadConfigFresh(
    dataDir: string,
    fileCfg?: Record<string, unknown>,
    opts: {
      AGENT_HUB_AGENT_URL?: string;
      mockedPort?: number;
    } = {},
  ): Promise<{ mod: typeof import('./config.js'); portSpy: ReturnType<typeof vi.spyOn> }> {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    process.env.AGENT_HUB_DATA_DIR = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    if (fileCfg !== undefined) {
      fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(fileCfg), 'utf8');
    }

    delete process.env.AGENT_HUB_AGENT_URL;
    if (opts.AGENT_HUB_AGENT_URL !== undefined) {
      process.env.AGENT_HUB_AGENT_URL = opts.AGENT_HUB_AGENT_URL;
    }
    delete process.env.AGENT_HUB_PUBLIC_URL;

    const serverPortMod = await import('./server-port.js');
    const mockPort = opts.mockedPort ?? 4242;
    const portSpy = vi.spyOn(serverPortMod, 'getActualPort').mockReturnValue(mockPort);
    const mod = await import('./config.js');
    return { mod, portSpy };
  }

  it('normalizes https origins (origin-only helper) and spawn bases (path preserved, OAuth-base parity)', async () => {
    const dir = path.join(
      os.tmpdir(),
      `agent-hub-http-origin-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    try {
      const { mod } = await loadConfigFresh(dir);
      expect(mod.normalizedHttpOriginForAgentHub('https://hub.example/with/path')).toBe(
        'https://hub.example',
      );
      expect(mod.normalizedHttpOriginForAgentHub('')).toBeNull();
      expect(mod.normalizedHttpOriginForAgentHub('ftp://bad')).toBeNull();
      expect(mod.normalizedHttpOriginForAgentHub('https://h.example/foo/')).toBe(
        'https://h.example',
      );

      expect(mod.normalizedHttpSpawnBaseForAgentHub('https://hub.example/with/path')).toBe(
        'https://hub.example/with/path',
      );
      expect(mod.normalizedHttpSpawnBaseForAgentHub('https://h.example/foo/')).toBe(
        'https://h.example/foo',
      );
      expect(mod.normalizedHttpSpawnBaseForAgentHub('https://host/app')).toBe('https://host/app');
      expect(mod.normalizedHttpSpawnBaseForAgentHub('')).toBeNull();
      expect(mod.normalizedHttpSpawnBaseForAgentHub('ftp://bad')).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to http://127.0.0.1:<actual port> when no agent URL configured', async () => {
    const dir = path.join(
      os.tmpdir(),
      `agent-hub-spawnurl-fallback-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    try {
      const { mod, portSpy } = await loadConfigFresh(dir);
      expect(mod.resolveAgentHubApiBaseForSpawn(mod.default)).toBe('http://127.0.0.1:4242');
      expect(portSpy).toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers path-preserving publicUrl (AGENT_HUB_PUBLIC_URL / config) over loopback', async () => {
    const dir = path.join(
      os.tmpdir(),
      `agent-hub-spawnurl-pub-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    try {
      const { mod } = await loadConfigFresh(dir, {
        publicUrl: 'https://svc.example/agent-hub/',
      });
      expect(mod.resolveAgentHubApiBaseForSpawn(mod.default)).toBe('https://svc.example/agent-hub');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers AGENT_HUB_AGENT_URL over publicUrl', async () => {
    const dir = path.join(
      os.tmpdir(),
      `agent-hub-spawnurl-env-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    try {
      const { mod } = await loadConfigFresh(
        dir,
        { publicUrl: 'https://public.example' },
        { AGENT_HUB_AGENT_URL: 'http://runner.internal:3051/' },
      );
      expect(mod.resolveAgentHubApiBaseForSpawn(mod.default)).toBe('http://runner.internal:3051');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves path on AGENT_HUB_AGENT_URL when set explicitly', async () => {
    const dir = path.join(
      os.tmpdir(),
      `agent-hub-spawnurl-agent-path-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    try {
      const { mod } = await loadConfigFresh(
        dir,
        { publicUrl: 'https://ignored.example' },
        { AGENT_HUB_AGENT_URL: 'https://worker.example/hub/' },
      );
      expect(mod.resolveAgentHubApiBaseForSpawn(mod.default)).toBe('https://worker.example/hub');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads agentHubUrl from config.json when env is unset', async () => {
    const dir = path.join(
      os.tmpdir(),
      `agent-hub-spawnurl-file-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    try {
      const { mod } = await loadConfigFresh(dir, {
        publicUrl: 'https://ignored.example',
        agentHubUrl: 'http://worker.svc.dev:8099/',
      });
      expect(mod.resolveAgentHubApiBaseForSpawn(mod.default)).toBe('http://worker.svc.dev:8099');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
