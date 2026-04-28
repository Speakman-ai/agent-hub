import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import {
  createTemplateExecutor,
  defaultCopyTree,
  defaultSpawnCommand,
  type SpawnCommand,
} from './template-executor.js';
import { _resetJobsForTests } from './orchestrator.js';
import { _resetTemplateCache, getTemplate } from './templates.js';

/** Find an executable on PATH. Used to skip toolchain-dependent tests. */
function hasBinary(bin: string): boolean {
  try {
    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], {
      stdio: 'ignore',
    });
    return which.status === 0;
  } catch {
    return false;
  }
}

const HAS_NPM = hasBinary('npm');

describe('template executor — copy-template phase', () => {
  let workspace: string;

  beforeEach(() => {
    _resetJobsForTests();
    _resetTemplateCache();
    workspace = mkdtempSync(path.join(os.tmpdir(), 'tmpl-copy-'));
  });
  afterEach(() => {
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('materializes the template tree into the workspace', async () => {
    const executor = createTemplateExecutor({
      resolveWorkspace: () => workspace,
    });
    const events: string[] = [];

    const result = await executor.runPhase('copy-template', {
      jobId: 'j1',
      projectId: 'proj-1',
      payload: { appType: 'web-app', stack: 'typescript-node-tsx' },
      log: (line) => events.push(line),
    });

    expect(result.status).toBe('ok');
    // Spot-check a few paths that must land in the workspace.
    expect(existsSync(path.join(workspace, 'package.json'))).toBe(true);
    expect(existsSync(path.join(workspace, 'src/index.ts'))).toBe(true);
    expect(existsSync(path.join(workspace, 'README.md'))).toBe(true);
    // The manifest must NOT leak into the scaffolded project.
    expect(existsSync(path.join(workspace, 'manifest.json'))).toBe(false);
  });

  it('honours stack:"idk" by falling back to the appType default (cli → go-cobra)', async () => {
    let copied: { src: string; dest: string } | null = null;
    const executor = createTemplateExecutor({
      resolveWorkspace: () => workspace,
      copyTree: (src, dest) => {
        copied = { src, dest };
      },
    });

    const result = await executor.runPhase('copy-template', {
      jobId: 'j2',
      projectId: 'p2',
      payload: { appType: 'cli', stack: 'idk' },
      log: () => {},
    });

    expect(result.status).toBe('ok');
    expect(copied).not.toBeNull();
    expect(copied!.src).toBe(getTemplate('go-cobra').filesDir);
  });

  it('honours an unrecognised stack by falling back through appType', async () => {
    let copied: string | null = null;
    const executor = createTemplateExecutor({
      resolveWorkspace: () => workspace,
      copyTree: (src) => {
        copied = src;
      },
    });

    // `fastapi-postgres` is a questionnaire value that has no matching template;
    // appType `api` routes it to python-fastapi-uv.
    await executor.runPhase('copy-template', {
      jobId: 'j3',
      projectId: 'p3',
      payload: { appType: 'api', stack: 'fastapi-postgres' },
      log: () => {},
    });

    expect(copied).toBe(getTemplate('python-fastapi-uv').filesDir);
  });
});

describe('template executor — wire-tests / wire-lint phases', () => {
  let workspace: string;

  beforeEach(() => {
    _resetTemplateCache();
    workspace = mkdtempSync(path.join(os.tmpdir(), 'tmpl-run-'));
  });
  afterEach(() => {
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('runs setup commands in order, then the test command', async () => {
    const calls: string[] = [];
    const fakeSpawn: SpawnCommand = async (command) => {
      calls.push(command);
      return { exitCode: 0, signal: null };
    };
    const executor = createTemplateExecutor({
      resolveWorkspace: () => workspace,
      spawnCommand: fakeSpawn,
      copyTree: () => {},
    });

    const result = await executor.runPhase('wire-tests', {
      jobId: 'j4',
      projectId: 'p4',
      payload: { appType: 'web-app', stack: 'typescript-node-tsx' },
      log: () => {},
    });

    expect(result.status).toBe('ok');
    // Matches the TS manifest: setup ["npm install"] followed by test "npm test"
    // (the package.json `test` script then invokes `tsx --test src/*.test.ts`).
    expect(calls).toEqual(['npm install', 'npm test']);
  });

  it('stops at the first setup failure and surfaces the exit code', async () => {
    const fakeSpawn: SpawnCommand = async (command) => {
      return command.includes('install')
        ? { exitCode: 2, signal: null }
        : { exitCode: 0, signal: null };
    };
    const executor = createTemplateExecutor({
      resolveWorkspace: () => workspace,
      spawnCommand: fakeSpawn,
      copyTree: () => {},
    });

    const result = await executor.runPhase('wire-tests', {
      jobId: 'j5',
      projectId: 'p5',
      payload: { appType: 'web-app', stack: 'typescript-node-tsx' },
      log: () => {},
    });

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe(2);
    expect(result.error?.message).toMatch(/setup failed: `npm install` exited 2/);
  });

  it('runs the lint command for wire-lint', async () => {
    const calls: string[] = [];
    const fakeSpawn: SpawnCommand = async (command) => {
      calls.push(command);
      return { exitCode: 0, signal: null };
    };
    const executor = createTemplateExecutor({
      resolveWorkspace: () => workspace,
      spawnCommand: fakeSpawn,
      copyTree: () => {},
    });

    const result = await executor.runPhase('wire-lint', {
      jobId: 'j6',
      projectId: 'p6',
      payload: { appType: 'cli', stack: 'go-cobra' },
      log: () => {},
    });

    expect(result.status).toBe('ok');
    // Matches the go-cobra manifest's lint command.
    expect(calls).toEqual(['golangci-lint run']);
  });

  it('streams stdout lines into ctx.log via the spawner', async () => {
    const logs: string[] = [];
    const fakeSpawn: SpawnCommand = async (_command, { log }) => {
      log('line one');
      log('line two');
      return { exitCode: 0, signal: null };
    };
    const executor = createTemplateExecutor({
      resolveWorkspace: () => workspace,
      spawnCommand: fakeSpawn,
      copyTree: () => {},
    });

    await executor.runPhase('wire-lint', {
      jobId: 'j7',
      projectId: 'p7',
      payload: { appType: 'cli', stack: 'go-cobra' },
      log: (line) => logs.push(line),
    });

    expect(logs).toContain('line one');
    expect(logs).toContain('line two');
  });

  it('delegates non-template phases to the fallback executor', async () => {
    const seen: string[] = [];
    const executor = createTemplateExecutor({
      resolveWorkspace: () => workspace,
      copyTree: () => {},
      fallback: {
        async runPhase(phase) {
          seen.push(phase);
          return { status: 'ok', message: 'from-fallback' };
        },
      },
    });

    const result = await executor.runPhase('git-init', {
      jobId: 'j8',
      projectId: 'p8',
      payload: { appType: 'web-app', stack: 'idk' },
      log: () => {},
    });

    expect(seen).toEqual(['git-init']);
    expect(result.message).toBe('from-fallback');
  });
});

// Regression: PM2 runs the server with NODE_ENV=production, which by default
// makes `npm install` skip devDependencies. Setup commands during provisioning
// (`npm install`, `npm test`, `npm run lint`) need the full dep graph, so the
// default spawner must strip NODE_ENV (and the matching npm_config_*) before
// invoking the child shell. Without this, `tsx`/`vitest`/`eslint` etc. silently
// fail with `<tool>: not found`.
describe('template executor — defaultSpawnCommand env hygiene', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(os.tmpdir(), 'tmpl-env-'));
  });
  afterEach(() => {
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('strips NODE_ENV / npm_config_production from the child env', async () => {
    const original = {
      NODE_ENV: process.env.NODE_ENV,
      npm_config_production: process.env.npm_config_production,
      npm_config_omit: process.env.npm_config_omit,
    };
    process.env.NODE_ENV = 'production';
    process.env.npm_config_production = 'true';
    process.env.npm_config_omit = 'dev';

    try {
      const lines: string[] = [];
      // `node -p` cross-platform; emits `<NODE_ENV>|<npm_config_production>|<npm_config_omit>`
      const cmd =
        "node -p \"[process.env.NODE_ENV||''," +
        "process.env.npm_config_production||''," +
        "process.env.npm_config_omit||''].join('|')\"";
      const result = await defaultSpawnCommand(cmd, {
        cwd: workspace,
        log: (line) => lines.push(line),
        timeoutMs: 30_000,
      });

      expect(result.exitCode).toBe(0);
      // The `$ <cmd>` echo line is index 0; the node output is the next line.
      const stdoutLine = lines.find((l) => l.includes('|') && !l.startsWith('$ '));
      expect(stdoutLine, `lines were: ${JSON.stringify(lines)}`).toBeDefined();
      expect(stdoutLine).toBe('||');
    } finally {
      // Restore — vitest shares process state across tests in the same worker.
      for (const [k, v] of Object.entries(original)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

// Real setup+test integration test. Heavy: it runs `npm install` in a tmpdir.
// Kept behind a skipIf so machines without npm (rare in CI but possible in
// container-restricted dev boxes) don't fail the suite. The 180s timeout
// covers a cold install of the template's seven devDependencies.
describe.skipIf(!HAS_NPM)('template executor — real setup+test (typescript-node-tsx)', () => {
  let workspace: string;

  beforeEach(() => {
    _resetTemplateCache();
    workspace = mkdtempSync(path.join(os.tmpdir(), 'tmpl-integration-'));
  });
  afterEach(() => {
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it(
    'copies the tree, installs deps, and the test command exits 0',
    { timeout: 180_000 },
    async () => {
      const executor = createTemplateExecutor({
        resolveWorkspace: () => workspace,
        copyTree: defaultCopyTree,
      });
      const events: string[] = [];
      const log = (line: string): void => {
        events.push(line);
      };

      const copyRes = await executor.runPhase('copy-template', {
        jobId: 'jint1',
        projectId: 'pint1',
        payload: { appType: 'web-app', stack: 'typescript-node-tsx' },
        log,
      });
      expect(copyRes.status).toBe('ok');
      expect(existsSync(path.join(workspace, 'package.json'))).toBe(true);

      // Sanity-check the package.json that was scaffolded — it should be
      // the template's, not some accidental copy of server/package.json.
      const pkg = JSON.parse(readFileSync(path.join(workspace, 'package.json'), 'utf8')) as {
        name: string;
        scripts: Record<string, string>;
      };
      expect(pkg.name).toBe('starter-typescript-node-tsx');
      expect(pkg.scripts['test']).toBeTruthy();

      const runRes = await executor.runPhase('wire-tests', {
        jobId: 'jint1',
        projectId: 'pint1',
        payload: { appType: 'web-app', stack: 'typescript-node-tsx' },
        log,
      });
      expect(
        runRes.status,
        `wire-tests failed. Last 20 log lines:\n${events.slice(-20).join('\n')}`,
      ).toBe('ok');
    },
  );
});
