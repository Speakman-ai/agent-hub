import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  readlinkSync,
  symlinkSync,
} from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import {
  buildTemplateSpawnEnv,
  createCopyTree,
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

  it('defaultCopyTree overwrites files in an existing dest directory', () => {
    // Project onboarding mkdir's workspace before copy-template runs. cpSync
    // then chmod's that dest dir to match the template — virtiofs EACCES.
    // This copier must only write files, not chmod the dest dir.
    const src = mkdtempSync(path.join(os.tmpdir(), 'tmpl-src-'));
    const dest = mkdtempSync(path.join(os.tmpdir(), 'tmpl-dest-'));
    try {
      writeFileSync(path.join(src, 'root.txt'), 'new-root');
      mkdirSync(path.join(src, 'nested'));
      writeFileSync(path.join(src, 'nested', 'child.txt'), 'child');
      writeFileSync(path.join(dest, 'root.txt'), 'old-root');
      defaultCopyTree(src, dest);
      expect(readFileSync(path.join(dest, 'root.txt'), 'utf8')).toBe('new-root');
      expect(readFileSync(path.join(dest, 'nested', 'child.txt'), 'utf8')).toBe('child');
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it.each(['EACCES', 'EPERM', 'ENOENT'])('backs up and retries a ghost file after %s', (code) => {
    const src = mkdtempSync(path.join(os.tmpdir(), 'tmpl-retry-src-'));
    const dest = mkdtempSync(path.join(os.tmpdir(), 'tmpl-retry-dest-'));
    try {
      const srcFile = path.join(src, 'root.txt');
      const destFile = path.join(dest, 'root.txt');
      writeFileSync(srcFile, 'new-root');
      writeFileSync(destFile, 'ghost');
      const copy = vi.fn((from: string, to: string) => {
        if (copy.mock.calls.length === 1) {
          const err = new Error(`${code}: simulated ghost file`) as NodeJS.ErrnoException;
          err.code = code;
          throw err;
        }
        copyFileSync(from, to);
      });
      const remove = vi.fn((target: string, options: { force: true; recursive?: true }) =>
        rmSync(target, options),
      );

      createCopyTree({ copyFileSync: copy, rmSync: remove })(src, dest);

      expect(copy).toHaveBeenCalledTimes(2);
      expect(remove).not.toHaveBeenCalledWith(destFile, { force: true });
      expect(remove).toHaveBeenCalledWith(
        expect.stringContaining(`${destFile}.agent-hub-copy-backup-`),
        { force: true, recursive: true },
      );
      expect(readFileSync(destFile, 'utf8')).toBe('new-root');
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it.each(['EACCES', 'EPERM', 'ENOENT'])(
    'restores an existing destination when a source-side %s repeats on retry',
    (code) => {
      const src = mkdtempSync(path.join(os.tmpdir(), 'tmpl-source-fail-src-'));
      const dest = mkdtempSync(path.join(os.tmpdir(), 'tmpl-source-fail-dest-'));
      try {
        const srcFile = path.join(src, 'root.txt');
        const destFile = path.join(dest, 'root.txt');
        writeFileSync(srcFile, 'unreadable-source');
        writeFileSync(destFile, 'keep-me');
        const copy = vi.fn(() => {
          const err = new Error(`${code}: simulated source failure`) as NodeJS.ErrnoException;
          err.code = code;
          err.path = srcFile;
          throw err;
        });

        expect(() => createCopyTree({ copyFileSync: copy })(src, dest)).toThrow(
          /simulated source failure/,
        );

        expect(copy).toHaveBeenCalledTimes(2);
        expect(readFileSync(destFile, 'utf8')).toBe('keep-me');
        expect(
          readdirSync(dest).filter((name) => name.includes('.agent-hub-copy-backup-')),
        ).toEqual([]);
      } finally {
        rmSync(src, { recursive: true, force: true });
        rmSync(dest, { recursive: true, force: true });
      }
    },
  );

  it('does not remove the destination after a non-recoverable copy error', () => {
    const src = mkdtempSync(path.join(os.tmpdir(), 'tmpl-fail-src-'));
    const dest = mkdtempSync(path.join(os.tmpdir(), 'tmpl-fail-dest-'));
    try {
      writeFileSync(path.join(src, 'root.txt'), 'new-root');
      const destFile = path.join(dest, 'root.txt');
      writeFileSync(destFile, 'keep-me');
      const original = new Error('EIO: simulated disk failure') as NodeJS.ErrnoException;
      original.code = 'EIO';
      const remove = vi.fn();
      const copyTree = createCopyTree({
        copyFileSync: () => {
          throw original;
        },
        rmSync: remove,
      });

      expect(() => copyTree(src, dest)).toThrow(original);
      expect(remove).not.toHaveBeenCalled();
      expect(readFileSync(destFile, 'utf8')).toBe('keep-me');
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it('preserves symbolic links from the template tree', () => {
    const src = mkdtempSync(path.join(os.tmpdir(), 'tmpl-link-src-'));
    const dest = mkdtempSync(path.join(os.tmpdir(), 'tmpl-link-dest-'));
    try {
      writeFileSync(path.join(src, 'target.txt'), 'target');
      symlinkSync('target.txt', path.join(src, 'link.txt'));

      defaultCopyTree(src, dest);

      expect(readlinkSync(path.join(dest, 'link.txt'))).toBe('target.txt');
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it('transactionally replaces a destination directory with a template symlink', () => {
    const src = mkdtempSync(path.join(os.tmpdir(), 'tmpl-link-collision-src-'));
    const dest = mkdtempSync(path.join(os.tmpdir(), 'tmpl-link-collision-dest-'));
    try {
      symlinkSync('target.txt', path.join(src, 'link'));
      mkdirSync(path.join(dest, 'link'));
      writeFileSync(path.join(dest, 'link', 'keep.txt'), 'old-directory-content');

      defaultCopyTree(src, dest);

      expect(readlinkSync(path.join(dest, 'link'))).toBe('target.txt');
      expect(readdirSync(dest).filter((name) => name.includes('.agent-hub-copy-backup-'))).toEqual(
        [],
      );
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it('restores a destination directory when a colliding symlink retry fails', () => {
    const src = mkdtempSync(path.join(os.tmpdir(), 'tmpl-link-fail-src-'));
    const dest = mkdtempSync(path.join(os.tmpdir(), 'tmpl-link-fail-dest-'));
    try {
      const destLink = path.join(dest, 'link');
      symlinkSync('target.txt', path.join(src, 'link'));
      mkdirSync(destLink);
      writeFileSync(path.join(destLink, 'keep.txt'), 'preserve-me');
      const createLink = vi.fn((_target: string, linkPath: string) => {
        if (createLink.mock.calls.length === 2) writeFileSync(linkPath, 'partial-retry-output');
        const err = new Error(
          createLink.mock.calls.length === 1 ? 'EEXIST: destination exists' : 'EPERM: retry failed',
        ) as NodeJS.ErrnoException;
        err.code = createLink.mock.calls.length === 1 ? 'EEXIST' : 'EPERM';
        throw err;
      });

      expect(() => createCopyTree({ symlinkSync: createLink })(src, dest)).toThrow(/retry failed/);

      expect(createLink).toHaveBeenCalledTimes(2);
      expect(readFileSync(path.join(destLink, 'keep.txt'), 'utf8')).toBe('preserve-me');
      expect(readdirSync(dest).filter((name) => name.includes('.agent-hub-copy-backup-'))).toEqual(
        [],
      );
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it('restores a colliding file when replacement by a directory fails', () => {
    const src = mkdtempSync(path.join(os.tmpdir(), 'tmpl-dir-fail-src-'));
    const dest = mkdtempSync(path.join(os.tmpdir(), 'tmpl-dir-fail-dest-'));
    try {
      mkdirSync(path.join(src, 'nested'));
      writeFileSync(path.join(src, 'nested', 'child.txt'), 'unreadable-source');
      const destNested = path.join(dest, 'nested');
      writeFileSync(destNested, 'preserve-file');
      const copy = vi.fn(() => {
        const err = new Error('EACCES: nested source failure') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      });

      expect(() => createCopyTree({ copyFileSync: copy })(src, dest)).toThrow(
        /nested source failure/,
      );

      expect(copy).toHaveBeenCalledTimes(2);
      expect(readFileSync(destNested, 'utf8')).toBe('preserve-file');
      expect(readdirSync(dest).filter((name) => name.includes('.agent-hub-copy-backup-'))).toEqual(
        [],
      );
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it('reports a copy failure as code 3 with a permission hint on EACCES', async () => {
    const executor = createTemplateExecutor({
      resolveWorkspace: () => workspace,
      copyTree: () => {
        const err = new Error(
          `EACCES: permission denied, mkdir '${workspace}'`,
        ) as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      },
    });

    const result = await executor.runPhase('copy-template', {
      jobId: 'j-eacces',
      projectId: 'proj-eacces',
      payload: { appType: 'web-app', stack: 'typescript-node-tsx' },
      log: () => {},
    });

    expect(result.status).toBe('failed');
    // -1 collides with the container-timeout hint; copy failures must be code 3.
    expect(result.error?.code).toBe(3);
    expect(result.error?.hint).toContain(workspace);
    expect(result.error?.hint).toMatch(/permission|ownership|UID/i);
  });

  it('reports a non-permission copy failure as code 3 without a permission hint', async () => {
    const executor = createTemplateExecutor({
      resolveWorkspace: () => workspace,
      copyTree: () => {
        throw new Error('ENOSPC: no space left on device');
      },
    });

    const result = await executor.runPhase('copy-template', {
      jobId: 'j-enospc',
      projectId: 'proj-enospc',
      payload: { appType: 'web-app', stack: 'typescript-node-tsx' },
      log: () => {},
    });

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe(3);
    expect(result.error?.hint).toBeUndefined();
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

  it('delegates phases outside template/git-init to the fallback executor', async () => {
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

    const result = await executor.runPhase('validate', {
      jobId: 'j8',
      projectId: 'p8',
      payload: { appType: 'web-app', stack: 'idk' },
      log: () => {},
    });

    expect(seen).toEqual(['validate']);
    expect(result.message).toBe('from-fallback');
  });
});

describe('template executor — git-init phase', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(os.tmpdir(), 'tmpl-git-'));
  });
  afterEach(() => {
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('runs git init in the workspace so gh repo create --source=. can succeed', async () => {
    const executor = createTemplateExecutor({
      resolveWorkspace: () => workspace,
    });

    const result = await executor.runPhase('git-init', {
      jobId: 'j-git',
      projectId: 'p-git',
      payload: {},
      log: () => {},
    });

    expect(result.status).toBe('ok');
    expect(existsSync(path.join(workspace, '.git'))).toBe(true);
  });
});

describe('buildTemplateSpawnEnv', () => {
  it('forces NODE_ENV=development so npm installs devDependencies', () => {
    // PM2 puts agent-hub in production. The starter ships tsx/typescript as
    // devDependencies, so inheriting NODE_ENV=production made `npm install`
    // skip them and `npm test` failed with "sh: 1: tsx: not found" (exit 127).
    const env = buildTemplateSpawnEnv({ NODE_ENV: 'production', PATH: '/usr/bin' });
    expect(env.NODE_ENV).toBe('development');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('strips NPM_CONFIG_PRODUCTION (both casings) so npm honours its defaults', () => {
    const env = buildTemplateSpawnEnv({
      NPM_CONFIG_PRODUCTION: 'true',
      npm_config_production: 'true',
      HOME: '/home/agenthub',
    });
    expect(env.NPM_CONFIG_PRODUCTION).toBeUndefined();
    expect(env.npm_config_production).toBeUndefined();
    // Unrelated vars pass through unchanged.
    expect(env.HOME).toBe('/home/agenthub');
  });

  it('strips NPM_CONFIG_OMIT (both casings) — npm 7+ honours --omit=dev independently', () => {
    // Defense-in-depth alongside NPM_CONFIG_PRODUCTION: npm 7+ deprecated
    // `--production` in favour of `--omit=dev`, exposed via `npm_config_omit`.
    // Even if PM2 isn't currently setting this, a future config change could,
    // and we want every `npm install` during provisioning to install devDeps.
    const env = buildTemplateSpawnEnv({
      NPM_CONFIG_OMIT: 'dev',
      npm_config_omit: 'dev',
      PATH: '/usr/bin',
    });
    expect(env.NPM_CONFIG_OMIT).toBeUndefined();
    expect(env.npm_config_omit).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('does not mutate the parent env object', () => {
    const parent = { NODE_ENV: 'production', NPM_CONFIG_PRODUCTION: 'true' };
    buildTemplateSpawnEnv(parent);
    expect(parent.NODE_ENV).toBe('production');
    expect(parent.NPM_CONFIG_PRODUCTION).toBe('true');
  });
});

// Regression: PM2 runs the server with NODE_ENV=production, which by default
// makes `npm install` skip devDependencies. Setup commands during provisioning
// (`npm install`, `npm test`, `npm run lint`) need the full dep graph, so the
// default spawner must strip NODE_ENV (and the matching npm_config_*) before
// invoking the child shell. Without this, `tsx`/`vitest`/`eslint` etc. silently
// fail with `<tool>: not found`. This is the integration counterpart to the
// `buildTemplateSpawnEnv` unit tests above — it verifies the env hygiene
// actually reaches the spawned shell, not just the helper return value.
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

  it('child shell sees NODE_ENV=development and no npm_config_production / npm_config_omit', async () => {
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
      // PR-side forces NODE_ENV=development; main-side just deleted it.
      // Forcing development is strictly stronger — npm install treats both
      // identically, but the running scripts also see the explicit signal.
      expect(stdoutLine).toBe('development||');
    } finally {
      // Restore — vitest shares process state across tests in the same worker.
      for (const [k, v] of Object.entries(original)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('starter templates — binary-on-PATH contract', () => {
  // Regression for "Provisioning fails on Wire tests: tsx not found".
  // Every npm-based starter MUST declare each binary referenced by its
  // `scripts` block as a (dev)Dependency, so that `npm install` produces
  // a working `node_modules/.bin/<bin>` even when NODE_ENV=production
  // would otherwise prune devDependencies.
  it('every npm-based starter declares the binaries its scripts reference', () => {
    const templatesDir = path.join(__dirname, 'templates');
    const ids = readdirSync(templatesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    const npmStarters: Array<{ id: string; pkg: PackageJsonShape }> = [];
    for (const id of ids) {
      const pkgPath = path.join(templatesDir, id, 'files', 'package.json');
      if (!existsSync(pkgPath)) continue;
      npmStarters.push({
        id,
        pkg: JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageJsonShape,
      });
    }

    // We expect at least one npm-based starter — guard against accidentally
    // deleting them all and silently passing the test.
    expect(npmStarters.length).toBeGreaterThan(0);

    for (const { id, pkg } of npmStarters) {
      const declared = new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ]);
      // Node built-ins / npm shipped commands that don't need a dependency entry.
      const NODE_BUILTINS = new Set(['npm', 'npx', 'node']);

      for (const [scriptName, scriptCmd] of Object.entries(pkg.scripts ?? {})) {
        for (const bin of extractBinaries(scriptCmd)) {
          if (NODE_BUILTINS.has(bin)) continue;
          expect(
            declared.has(bin),
            `starter "${id}" script "${scriptName}" runs "${bin}" but neither dependencies nor devDependencies declare a "${bin}" package`,
          ).toBe(true);
        }
      }
    }
  });
});

interface PackageJsonShape {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * Extract the leading binary name from each `&&`/`;`/`|` segment of a
 * shell command. Crude on purpose — we want false positives (extra
 * binaries flagged) rather than false negatives (a missing tsx that
 * slips through). Skips obvious shell builtins and `npm run <name>`
 * which dispatches to another script entry.
 */
function extractBinaries(command: string): string[] {
  const SHELL_BUILTINS = new Set([
    'cd',
    'echo',
    'export',
    'set',
    'true',
    'false',
    'if',
    'then',
    'else',
    'fi',
    'rm',
    'mkdir',
    'cp',
    'mv',
    'cat',
    'test',
    '[',
  ]);
  const segments = command.split(/&&|\|\||;|\|/);
  const bins: string[] = [];
  for (const segRaw of segments) {
    const seg = segRaw.trim();
    if (!seg) continue;
    const tokens = seg.split(/\s+/);
    let head = tokens[0];
    // `npm run foo` chains within the same package — not a missing binary.
    if (head === 'npm' && tokens[1] === 'run') continue;
    // `npx foo` is npm-shipped; skip the `npx` itself.
    if (head === 'npx') head = tokens[1] ?? '';
    if (!head || SHELL_BUILTINS.has(head)) continue;
    bins.push(head);
  }
  return bins;
}

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
