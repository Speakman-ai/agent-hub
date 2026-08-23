/**
 * Guards the hard safety rail in config.ts that refuses to load in test
 * context against a real data dir.
 *
 * History: after the designs-wipe incident the rail was
 * `TEST_MODE=1 && DATA_DIR === default`. On 2026-07-01 that form failed
 * twice over — a vitest run that never loaded vitest.config.ts had no
 * AGENT_HUB_TEST_MODE, and its inherited AGENT_HUB_DATA_DIR wasn't the
 * *default* path — and the deploy tests wiped every kanban board in prod.
 * config.ts now delegates to `assertSafeTestDataDir` (server/db-safety.ts),
 * which detects test context from vitest's own worker env and rejects ANY
 * dir outside os.tmpdir(). See server/db-safety.test.ts for the guard's own
 * unit coverage; these tests pin the config.ts module-load wiring.
 *
 * These tests import config.ts fresh per case via vi.resetModules().
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { shouldPassModelFlag, CODEX_CHATGPT_ALLOWED_MODELS } from './codex-auth.js';
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

describe('config.ts — test-context safety rail (assertSafeTestDataDir wiring)', () => {
  /** Strip every test-context marker so config.ts sees a prod-shaped env. */
  function clearTestContextEnv(): void {
    delete process.env.AGENT_HUB_TEST_MODE;
    delete process.env.VITEST;
    delete process.env.VITEST_POOL_ID;
    delete process.env.VITEST_WORKER_ID;
    delete process.env.NODE_ENV;
  }

  it('throws when AGENT_HUB_TEST_MODE=1 and AGENT_HUB_DATA_DIR is unset (resolves to prod default)', async () => {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    delete process.env.AGENT_HUB_DATA_DIR;

    await expect(import('./config.js')).rejects.toThrow(/db-safety.*REFUSING to open database dir/);
  });

  it('throws when AGENT_HUB_TEST_MODE=1 and AGENT_HUB_DATA_DIR explicitly equals production default', async () => {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    process.env.AGENT_HUB_DATA_DIR = PRODUCTION_DEFAULT;

    await expect(import('./config.js')).rejects.toThrow(/db-safety.*REFUSING to open database dir/);
  });

  it('throws for an inherited NON-default prod dir with only vitest worker env (the 2026-07-01 shape)', async () => {
    // The incident: no AGENT_HUB_TEST_MODE (vitest.config.ts never loaded),
    // AGENT_HUB_DATA_DIR explicitly inherited from the server's spawn env —
    // not the default path. Only vitest's own env marks the process a test.
    vi.resetModules();
    delete process.env.AGENT_HUB_TEST_MODE;
    process.env.AGENT_HUB_DATA_DIR = path.join(os.homedir(), 'not-the-default', 'data');
    // (VITEST / NODE_ENV=test are genuinely present in this process.)

    await expect(import('./config.js')).rejects.toThrow(/db-safety.*REFUSING to open database dir/);
  });

  it('loads cleanly when AGENT_HUB_TEST_MODE=1 and AGENT_HUB_DATA_DIR points at a tmp dir', async () => {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    process.env.AGENT_HUB_DATA_DIR = path.join(os.tmpdir(), `agent-hub-guard-ok-${process.pid}`);
    delete process.env.AGENT_HUB_PROJECTS_DIR;

    const mod = await import('./config.js');
    expect(mod.default.dataDir).toBe(process.env.AGENT_HUB_DATA_DIR);
    expect(mod.default.projectsDir).toBe(path.join(process.env.AGENT_HUB_DATA_DIR, 'projects'));
  });

  it('throws when AGENT_HUB_PROJECTS_DIR points at the live projects tree even if dataDir is tmp', async () => {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    process.env.AGENT_HUB_DATA_DIR = path.join(os.tmpdir(), `agent-hub-guard-ok-${process.pid}`);
    process.env.AGENT_HUB_PROJECTS_DIR = path.join(os.homedir(), '.agent-hub', 'projects');

    await expect(import('./config.js')).rejects.toThrow(/db-safety.*REFUSING to use projects dir/);
  });

  it('does NOT throw in production (no test-context env) even when dataDir is the default', async () => {
    vi.resetModules();
    clearTestContextEnv();
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
    'claude-code': ['claude-opus-4-8'],
    'gemini-cli': ['gemini-2.5-pro'],
    'codex-cli': ['gpt-5.3-codex'],
  };
  const nonCursorDefaults: Record<string, string> = {
    'claude-code': 'claude-opus-4-8',
    'gemini-cli': 'gemini-2.5-pro',
    'codex-cli': 'gpt-5.3-codex',
  };

  it('strips legacy IDs to the Hub Cursor CLI allowlist', async () => {
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
          'composer-2.5',
          'cursor-grok-4.5-high',
        ],
      },
      engineDefaultModels: { ...nonCursorDefaults, 'cursor-agent': 'composer-2' },
    });

    const mod = await import('./config.js');
    expect(mod.default.engineValidModels['claude-code']).toEqual(['claude-opus-4-8']);
    expect(mod.default.engineValidModels['cursor-agent']).toEqual([
      'composer-2.5',
      'cursor-grok-4.5-high',
    ]);
  });

  it('keeps cursor-grok-4.6-high when a config lists it (Cursor CLI slug)', async () => {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    const dataDir = path.join(
      os.tmpdir(),
      `agent-hub-cursor-46-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    process.env.AGENT_HUB_DATA_DIR = dataDir;
    writeConfigAndImport(dataDir, {
      engineValidModels: {
        ...nonCursorValid,
        'cursor-agent': ['auto', 'cursor-grok-4.6-high', 'composer-2.5'],
      },
      engineDefaultModels: { ...nonCursorDefaults, 'cursor-agent': 'cursor-grok-4.6-high' },
    });

    const mod = await import('./config.js');
    expect(mod.default.engineValidModels['cursor-agent']).toEqual([
      'cursor-grok-4.6-high',
      'composer-2.5',
    ]);
    expect(mod.default.engineDefaultModels['cursor-agent']).toBe('cursor-grok-4.6-high');
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
        'cursor-agent': ['gpt-5.3-codex-high', 'composer-2.5', 'auto'],
      },
      engineDefaultModels: { ...nonCursorDefaults, 'cursor-agent': 'gpt-5.3-codex-high' },
    });

    const mod = await import('./config.js');
    expect(mod.default.engineValidModels['cursor-agent']).toEqual(['composer-2.5']);
    expect(mod.default.engineDefaultModels['cursor-agent']).toBe('composer-2.5');
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
    expect(mod.default.engineValidModels['cursor-agent']).toEqual([
      'cursor-grok-4.6-high',
      'composer-2.5',
      'cursor-grok-4.5-high',
    ]);
    expect(mod.default.engineDefaultModels['cursor-agent']).toBe('cursor-grok-4.6-high');
  });

  it('defaults cursor-agent to cursor-grok-4.6-high with no config.json', async () => {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    const dataDir = path.join(
      os.tmpdir(),
      `agent-hub-cursor-builtin-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({}), 'utf8');
    process.env.AGENT_HUB_DATA_DIR = dataDir;

    const mod = await import('./config.js');
    const valid = mod.default.engineValidModels['cursor-agent'];
    expect(valid[0]).toBe('cursor-grok-4.6-high');
    expect(valid).toContain('composer-2.5');
    expect(mod.default.engineDefaultModels['cursor-agent']).toBe('cursor-grok-4.6-high');
  });
});

describe('config.ts — codex-cli model defaults', () => {
  // No config.json is written, so config.ts falls back to its built-in
  // DEFAULT_ENGINE_VALID_MODELS / DEFAULT_ENGINE_DEFAULT_MODELS.
  async function importDefaults() {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    process.env.AGENT_HUB_DATA_DIR = path.join(
      os.tmpdir(),
      `agent-hub-codex-defaults-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    return (await import('./config.js')).default;
  }

  it('offers the baseline Codex models and configures Sol as the default', async () => {
    const cfg = await importDefaults();
    expect(cfg.engineValidModels['codex-cli']).toEqual([
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.2',
    ]);
    expect(cfg.engineDefaultModels['codex-cli']).toBe('gpt-5.6-sol');
  });

  it('keeps the capability-gated default out of the static baseline', async () => {
    const cfg = await importDefaults();
    expect(cfg.engineValidModels['codex-cli']).not.toContain('gpt-5.6-sol');
    expect(cfg.engineDefaultModels['codex-cli']).toBe('gpt-5.6-sol');
  });

  it('forwards the Codex default only when capability metadata advertises it', async () => {
    const cfg = await importDefaults();
    const codexDefault = cfg.engineDefaultModels['codex-cli'];
    expect(CODEX_CHATGPT_ALLOWED_MODELS).not.toContain(codexDefault);
    expect(shouldPassModelFlag('chatgpt', codexDefault)).toBe(false);
    expect(shouldPassModelFlag('chatgpt', codexDefault, [codexDefault])).toBe(true);
  });

  it('does NOT offer gpt-5.3-codex — deprecated, rejected under ChatGPT OAuth', async () => {
    // Regression: gpt-5.3-codex was the prior default but the ChatGPT backend
    // now rejects it (HTTP 400), so it must not be selectable or the default.
    const cfg = await importDefaults();
    expect(cfg.engineValidModels['codex-cli']).not.toContain('gpt-5.3-codex');
    expect(cfg.engineDefaultModels['codex-cli']).not.toBe('gpt-5.3-codex');
    expect(cfg.engineDefaultModels['codex-cli']).toBe('gpt-5.6-sol');
  });
});

describe('config.ts — claude-code model defaults', () => {
  // No config.json is written, so config.ts falls back to its built-in
  // DEFAULT_ENGINE_VALID_MODELS / DEFAULT_ENGINE_DEFAULT_MODELS.
  async function importDefaults() {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    process.env.AGENT_HUB_DATA_DIR = path.join(
      os.tmpdir(),
      `agent-hub-claude-defaults-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    return (await import('./config.js')).default;
  }

  it('offers claude-opus-5 as a selectable claude-code model', async () => {
    // Regression: Claude Opus 5 (API id `claude-opus-5`) is Anthropic's flagship
    // Opus model and must be selectable, otherwise PUT /api/sessions/:id/model
    // rejects it as invalid.
    const cfg = await importDefaults();
    expect(cfg.engineValidModels['claude-code']).toContain('claude-opus-5');
    expect(cfg.allValidModels).toContain('claude-opus-5');
  });

  it('lists claude-opus-5 first as the flagship claude-code option', async () => {
    const cfg = await importDefaults();
    expect(cfg.engineValidModels['claude-code'][0]).toBe('claude-opus-5');
  });

  it('defaults claude-code to claude-opus-5', async () => {
    // Regression: claude-opus-5 is the configured claude-code + top-level default.
    const cfg = await importDefaults();
    expect(cfg.engineDefaultModels['claude-code']).toBe('claude-opus-5');
    expect(cfg.defaultModel).toBe('claude-opus-5');
  });

  it('still offers claude-fable-5 as a selectable claude-code model', async () => {
    // Claude Fable 5 (API id `claude-fable-5`, released 2026-06-09) remains a
    // selectable Mythos-class option below Opus 5.
    const cfg = await importDefaults();
    expect(cfg.engineValidModels['claude-code']).toContain('claude-fable-5');
    expect(cfg.allValidModels).toContain('claude-fable-5');
  });

  it('keeps the claude-code default in its valid model list', async () => {
    const cfg = await importDefaults();
    expect(cfg.engineValidModels['claude-code']).toContain(cfg.engineDefaultModels['claude-code']);
  });

  it('offers claude-sonnet-5 and drops the retired claude-sonnet-4-6', async () => {
    // Regression: Claude Sonnet 5 (API id `claude-sonnet-5`, released 2026-06-30)
    // replaces claude-sonnet-4-6 as the selectable Sonnet-tier option. The old id
    // must no longer be selectable, otherwise the picker offers a retired model.
    const cfg = await importDefaults();
    expect(cfg.engineValidModels['claude-code']).toContain('claude-sonnet-5');
    expect(cfg.allValidModels).toContain('claude-sonnet-5');
    expect(cfg.engineValidModels['claude-code']).not.toContain('claude-sonnet-4-6');
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

describe('config.ts — codexProfile resolution', () => {
  // codexProfile threads `--profile <name>` onto every codex spawn so operators
  // can pin a `~/.codex/config.toml` profile without per-call wiring. Empty /
  // whitespace must normalize to null so the chat-spawn site can skip the flag
  // with a single truthiness check.
  function freshDataDir(label: string): string {
    return path.join(
      os.tmpdir(),
      `agent-hub-codex-profile-${label}-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
  }

  function writeConfig(dir: string, body: Record<string, unknown>): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(body), 'utf8');
  }

  it('defaults to null when neither env nor config.json sets it', async () => {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    process.env.AGENT_HUB_DATA_DIR = freshDataDir('default');
    delete process.env.CODEX_PROFILE;
    const mod = await import('./config.js');
    expect(mod.default.codexProfile).toBeNull();
  });

  it('reads CODEX_PROFILE env when set (env wins over config.json)', async () => {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    const dir = freshDataDir('env-wins');
    process.env.AGENT_HUB_DATA_DIR = dir;
    process.env.CODEX_PROFILE = 'env-profile';
    writeConfig(dir, { codexProfile: 'file-profile' });
    const mod = await import('./config.js');
    expect(mod.default.codexProfile).toBe('env-profile');
  });

  it('reads codexProfile from config.json when env is unset', async () => {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    const dir = freshDataDir('file');
    process.env.AGENT_HUB_DATA_DIR = dir;
    delete process.env.CODEX_PROFILE;
    writeConfig(dir, { codexProfile: 'file-profile' });
    const mod = await import('./config.js');
    expect(mod.default.codexProfile).toBe('file-profile');
  });

  it('normalizes whitespace-only / empty to null', async () => {
    for (const raw of ['   ', '', '\t\n']) {
      vi.resetModules();
      process.env.AGENT_HUB_TEST_MODE = '1';
      const dir = freshDataDir(`empty-${Math.random().toString(36).slice(2)}`);
      process.env.AGENT_HUB_DATA_DIR = dir;
      process.env.CODEX_PROFILE = raw;
      const mod = await import('./config.js');
      expect(mod.default.codexProfile).toBeNull();
    }
  });

  it('trims surrounding whitespace', async () => {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    const dir = freshDataDir('trim');
    process.env.AGENT_HUB_DATA_DIR = dir;
    process.env.CODEX_PROFILE = '  my-profile  ';
    const mod = await import('./config.js');
    expect(mod.default.codexProfile).toBe('my-profile');
  });
});

describe('config.ts — dbInstrumentation resolution', () => {
  // Phase-1 async-DB instrumentation block: OFF by default, env overrides
  // enabled + threshold, threshold clamped to [0, 60000].
  function freshDataDir(label: string): string {
    return path.join(
      os.tmpdir(),
      `agent-hub-dbinstr-${label}-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
  }

  function writeConfig(dir: string, body: Record<string, unknown>): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(body), 'utf8');
  }

  function clearEnv(): void {
    delete process.env.AGENT_HUB_DB_INSTRUMENTATION;
    delete process.env.AGENT_HUB_DB_SLOW_THRESHOLD_MS;
  }

  it('defaults to disabled, 10ms threshold, logSlow on', async () => {
    vi.resetModules();
    clearEnv();
    process.env.AGENT_HUB_TEST_MODE = '1';
    process.env.AGENT_HUB_DATA_DIR = freshDataDir('default');
    const mod = await import('./config.js');
    expect(mod.default.dbInstrumentation).toEqual({
      enabled: false,
      slowThresholdMs: 10,
      logSlow: true,
    });
  });

  it('enables via AGENT_HUB_DB_INSTRUMENTATION env (truthy forms)', async () => {
    for (const raw of ['1', 'true', 'on', 'yes']) {
      vi.resetModules();
      clearEnv();
      process.env.AGENT_HUB_TEST_MODE = '1';
      process.env.AGENT_HUB_DATA_DIR = freshDataDir(`en-${raw}`);
      process.env.AGENT_HUB_DB_INSTRUMENTATION = raw;
      const mod = await import('./config.js');
      expect(mod.default.dbInstrumentation.enabled).toBe(true);
    }
  });

  it('env falsy form disables even when config.json enables it (env wins)', async () => {
    vi.resetModules();
    clearEnv();
    process.env.AGENT_HUB_TEST_MODE = '1';
    const dir = freshDataDir('env-false-wins');
    process.env.AGENT_HUB_DATA_DIR = dir;
    process.env.AGENT_HUB_DB_INSTRUMENTATION = 'off';
    writeConfig(dir, { dbInstrumentation: { enabled: true } });
    const mod = await import('./config.js');
    expect(mod.default.dbInstrumentation.enabled).toBe(false);
  });

  it('reads the block from config.json when env is unset', async () => {
    vi.resetModules();
    clearEnv();
    process.env.AGENT_HUB_TEST_MODE = '1';
    const dir = freshDataDir('file');
    process.env.AGENT_HUB_DATA_DIR = dir;
    writeConfig(dir, { dbInstrumentation: { enabled: true, slowThresholdMs: 25, logSlow: false } });
    const mod = await import('./config.js');
    expect(mod.default.dbInstrumentation).toEqual({
      enabled: true,
      slowThresholdMs: 25,
      logSlow: false,
    });
  });

  it('env threshold wins over config.json and clamps to [0, 60000]', async () => {
    // over-max clamps down
    {
      vi.resetModules();
      clearEnv();
      process.env.AGENT_HUB_TEST_MODE = '1';
      const dir = freshDataDir('clamp-hi');
      process.env.AGENT_HUB_DATA_DIR = dir;
      process.env.AGENT_HUB_DB_SLOW_THRESHOLD_MS = '999999';
      writeConfig(dir, { dbInstrumentation: { slowThresholdMs: 30 } });
      const mod = await import('./config.js');
      expect(mod.default.dbInstrumentation.slowThresholdMs).toBe(60_000);
    }
    // negative clamps up to 0
    {
      vi.resetModules();
      clearEnv();
      process.env.AGENT_HUB_TEST_MODE = '1';
      process.env.AGENT_HUB_DATA_DIR = freshDataDir('clamp-lo');
      process.env.AGENT_HUB_DB_SLOW_THRESHOLD_MS = '-5';
      const mod = await import('./config.js');
      expect(mod.default.dbInstrumentation.slowThresholdMs).toBe(0);
    }
    // valid env value passes through
    {
      vi.resetModules();
      clearEnv();
      process.env.AGENT_HUB_TEST_MODE = '1';
      process.env.AGENT_HUB_DATA_DIR = freshDataDir('valid');
      process.env.AGENT_HUB_DB_SLOW_THRESHOLD_MS = '50';
      const mod = await import('./config.js');
      expect(mod.default.dbInstrumentation.slowThresholdMs).toBe(50);
    }
  });

  it('non-numeric env threshold falls back to the 10ms default', async () => {
    vi.resetModules();
    clearEnv();
    process.env.AGENT_HUB_TEST_MODE = '1';
    process.env.AGENT_HUB_DATA_DIR = freshDataDir('nan');
    process.env.AGENT_HUB_DB_SLOW_THRESHOLD_MS = 'not-a-number';
    const mod = await import('./config.js');
    expect(mod.default.dbInstrumentation.slowThresholdMs).toBe(10);
  });
});

describe('config.ts — dbReaderPool resolution', () => {
  // Phase-2 async-DB reader pool block: sensible defaults, config.json read,
  // env overrides, and clamping of each field to its bounds.
  function freshDataDir(label: string): string {
    return path.join(
      os.tmpdir(),
      `agent-hub-dbreader-${label}-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
  }

  function writeConfig(dir: string, body: Record<string, unknown>): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(body), 'utf8');
  }

  function clearEnv(): void {
    delete process.env.AGENT_HUB_DB_READER_POOL_SIZE;
    delete process.env.AGENT_HUB_DB_READER_QUERY_TIMEOUT_MS;
    delete process.env.AGENT_HUB_DB_READER_MAX_QUEUE_DEPTH;
    delete process.env.AGENT_HUB_DB_READER_BUSY_TIMEOUT_MS;
  }

  it('defaults: size 2, 30s timeout, 1000 queue depth, 5s busy timeout', async () => {
    vi.resetModules();
    clearEnv();
    process.env.AGENT_HUB_TEST_MODE = '1';
    process.env.AGENT_HUB_DATA_DIR = freshDataDir('default');
    const mod = await import('./config.js');
    expect(mod.default.dbReaderPool).toEqual({
      size: 2,
      queryTimeoutMs: 30_000,
      maxQueueDepth: 1_000,
      busyTimeoutMs: 5_000,
    });
  });

  it('reads the block from config.json when env is unset', async () => {
    vi.resetModules();
    clearEnv();
    process.env.AGENT_HUB_TEST_MODE = '1';
    const dir = freshDataDir('file');
    process.env.AGENT_HUB_DATA_DIR = dir;
    writeConfig(dir, {
      dbReaderPool: { size: 4, queryTimeoutMs: 12_000, maxQueueDepth: 50, busyTimeoutMs: 250 },
    });
    const mod = await import('./config.js');
    expect(mod.default.dbReaderPool).toEqual({
      size: 4,
      queryTimeoutMs: 12_000,
      maxQueueDepth: 50,
      busyTimeoutMs: 250,
    });
  });

  it('env overrides win over config.json', async () => {
    vi.resetModules();
    clearEnv();
    process.env.AGENT_HUB_TEST_MODE = '1';
    const dir = freshDataDir('env-wins');
    process.env.AGENT_HUB_DATA_DIR = dir;
    writeConfig(dir, { dbReaderPool: { size: 8 } });
    process.env.AGENT_HUB_DB_READER_POOL_SIZE = '3';
    const mod = await import('./config.js');
    expect(mod.default.dbReaderPool.size).toBe(3);
  });

  it('clamps size to [1, 16] and queue depth / timeouts to their bounds', async () => {
    vi.resetModules();
    clearEnv();
    process.env.AGENT_HUB_TEST_MODE = '1';
    process.env.AGENT_HUB_DATA_DIR = freshDataDir('clamp');
    process.env.AGENT_HUB_DB_READER_POOL_SIZE = '999';
    process.env.AGENT_HUB_DB_READER_QUERY_TIMEOUT_MS = '1';
    process.env.AGENT_HUB_DB_READER_MAX_QUEUE_DEPTH = '0';
    process.env.AGENT_HUB_DB_READER_BUSY_TIMEOUT_MS = '999999';
    const mod = await import('./config.js');
    expect(mod.default.dbReaderPool).toEqual({
      size: 16,
      queryTimeoutMs: 100,
      maxQueueDepth: 1,
      busyTimeoutMs: 60_000,
    });
  });

  it('non-numeric env values fall back to defaults', async () => {
    vi.resetModules();
    clearEnv();
    process.env.AGENT_HUB_TEST_MODE = '1';
    process.env.AGENT_HUB_DATA_DIR = freshDataDir('nan');
    process.env.AGENT_HUB_DB_READER_POOL_SIZE = 'not-a-number';
    const mod = await import('./config.js');
    expect(mod.default.dbReaderPool.size).toBe(2);
  });
});

describe('config.ts — grok-cli default model list', () => {
  function freshDataDirNoConfig(tag: string): string {
    const dir = path.join(
      os.tmpdir(),
      `agent-hub-grok-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(dir, { recursive: true });
    // Empty config.json → engine* maps are absent, so the built-in DEFAULT_*
    // maps apply (config.json replaces whole maps, never deep-merges).
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({}), 'utf8');
    return dir;
  }

  it('defaults grok-cli to grok-4.6 and lists it first (current Grok Build model)', async () => {
    // Regression: the list predated grok-4.6 (shipped 2026-08-07) so users
    // could not select the model that now backs Grok Build upstream. grok-4.5
    // stays selectable for sessions/agents pinned to it.
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    process.env.AGENT_HUB_DATA_DIR = freshDataDirNoConfig('default');
    const mod = await import('./config.js');
    const valid = mod.default.engineValidModels['grok-cli'];
    expect(valid[0]).toBe('grok-4.6');
    expect(valid).toContain('grok-4.5');
    expect(valid).toContain('grok-build');
    expect(valid).toContain('grok-composer-2.5-fast');
    expect(mod.default.engineDefaultModels['grok-cli']).toBe('grok-4.6');
  });

  it('resolveGrokSpawnModel passes grok-4.6 / grok-4.5 through when allowlisted', async () => {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    process.env.AGENT_HUB_DATA_DIR = freshDataDirNoConfig('spawn');
    const mod = await import('./config.js');
    const cfg = {
      engineValidModels: mod.default.engineValidModels,
      engineDefaultModels: mod.default.engineDefaultModels,
    };
    expect(mod.resolveGrokSpawnModel('grok-4.6', cfg)).toBe('grok-4.6');
    expect(mod.resolveGrokSpawnModel('grok-4.5', cfg)).toBe('grok-4.5');
    // An unknown id still falls back to the grok-4.6 default.
    expect(mod.resolveGrokSpawnModel('grok-9-imaginary', cfg)).toBe('grok-4.6');
  });
});

describe('config.ts — host (bind address) resolution', () => {
  // config.host is what server/index.ts passes to server.listen(). It MUST
  // default to 0.0.0.0 (all interfaces) so LAN/server deployments keep working,
  // and honor AGENT_HUB_HOST / `host` so a shared host can restrict the API to
  // loopback (127.0.0.1). Regression: the value was resolved but index.ts
  // hardcoded '0.0.0.0' in listen(), so AGENT_HUB_HOST=127.0.0.1 did nothing.
  function freshDataDir(label: string): string {
    return path.join(
      os.tmpdir(),
      `agent-hub-host-${label}-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
  }

  function writeConfig(dir: string, body: Record<string, unknown>): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(body), 'utf8');
  }

  it('defaults to 0.0.0.0 when neither env nor config.json sets it', async () => {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    process.env.AGENT_HUB_DATA_DIR = freshDataDir('default');
    delete process.env.AGENT_HUB_HOST;
    const mod = await import('./config.js');
    expect(mod.default.host).toBe('0.0.0.0');
  });

  it('honors AGENT_HUB_HOST=127.0.0.1 (loopback lock) over the default', async () => {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    process.env.AGENT_HUB_DATA_DIR = freshDataDir('env-loopback');
    process.env.AGENT_HUB_HOST = '127.0.0.1';
    const mod = await import('./config.js');
    expect(mod.default.host).toBe('127.0.0.1');
    delete process.env.AGENT_HUB_HOST;
  });

  it('env AGENT_HUB_HOST wins over config.json host', async () => {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    const dir = freshDataDir('env-wins');
    process.env.AGENT_HUB_DATA_DIR = dir;
    writeConfig(dir, { host: '10.0.0.5' });
    process.env.AGENT_HUB_HOST = '127.0.0.1';
    const mod = await import('./config.js');
    expect(mod.default.host).toBe('127.0.0.1');
    delete process.env.AGENT_HUB_HOST;
  });

  it('reads host from config.json when env is unset', async () => {
    vi.resetModules();
    process.env.AGENT_HUB_TEST_MODE = '1';
    const dir = freshDataDir('file');
    process.env.AGENT_HUB_DATA_DIR = dir;
    delete process.env.AGENT_HUB_HOST;
    writeConfig(dir, { host: '127.0.0.1' });
    const mod = await import('./config.js');
    expect(mod.default.host).toBe('127.0.0.1');
  });
});

describe('server/index.ts — server.listen() binds config.host (regression guard)', () => {
  // The resolution tests above prove config.host is *computed* correctly, but
  // the actual regression was that index.ts hardcoded '0.0.0.0' in the
  // server.listen() call, so a correctly-resolved config.host was ignored and
  // AGENT_HUB_HOST=127.0.0.1 did nothing. That listen() call lives inside the
  // `NODE_ENV !== 'test'` boot guard, so it never executes under Vitest and
  // can't be observed at runtime. We therefore assert on the source the same
  // way this file already guards the Terraform/workflow bootstrap scripts:
  // observe the address literally passed to server.listen(). These assertions
  // FAIL if index.ts reverts to `server.listen(PORT, '0.0.0.0', …)`.
  const indexSrc = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts'),
    'utf8',
  );

  it('derives the bind host from config.host (no hardcoded default at the call site)', () => {
    expect(indexSrc).toMatch(/const\s+HOST\s*:\s*string\s*=\s*config\.host\s*;/);
  });

  it('passes the config-derived HOST as the bind address to server.listen()', () => {
    const listenCalls = indexSrc.match(/server\.listen\([^)]*\)/g) ?? [];
    // Exactly one listener; guarding against a second, differently-bound call.
    expect(listenCalls).toHaveLength(1);
    expect(listenCalls[0]).toMatch(/server\.listen\(\s*PORT\s*,\s*HOST\s*,/);
  });

  it('does NOT bind server.listen() to a hardcoded IP string literal', () => {
    // The exact shape of the pre-fix regression — a string-literal address as
    // the second argument to listen() (e.g. '0.0.0.0' or '127.0.0.1').
    expect(indexSrc).not.toMatch(/server\.listen\(\s*[A-Za-z0-9_]+\s*,\s*['"][\d.]+['"]/);
  });
});
