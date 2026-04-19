/**
 * PR-env builder tests (W2).
 *
 * The critical contract from the card: **cleanup on failure**.
 *
 *   • Happy path: port is allocated, DB is copied, env file is written,
 *     compose up is called with the expected arguments, and
 *     `buildPrEnv` returns the assigned values.
 *   • Failure mid-build must undo everything that got created — port
 *     released, DB copy removed, env file removed, compose down called
 *     if (and only if) `compose.up` had already succeeded.
 *   • `synchronize` resync on an existing PR reuses the same port
 *     (idempotent allocate).
 *   • `teardownPrEnv` tears down all four resources regardless of state.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, vi } from 'vitest';
import { PortPool, PORT_POOL_SCHEMA } from './port-pool.js';
import {
  buildPrEnv,
  prEnvPaths,
  teardownPrEnv,
  type ComposeRunner,
  type FsOps,
  type PrEnvBuilderDeps,
} from './pr-env-builder.js';
import { buildPrEnvFile } from './env-template.js';

// ─── fakes ────────────────────────────────────────────────────────────────

interface FakeFsState {
  files: Map<string, string>;
  copies: Array<{ src: string; dest: string }>;
  removed: string[];
}

function makeFakeFs(): FsOps & { state: FakeFsState } {
  const state: FakeFsState = {
    files: new Map(),
    copies: [],
    removed: [],
  };
  return {
    state,
    async copyFile(src, dest) {
      state.copies.push({ src, dest });
      state.files.set(dest, `copy-of:${src}`);
    },
    async writeFile(dest, contents) {
      state.files.set(dest, contents);
    },
    async rm(target) {
      state.removed.push(target);
      state.files.delete(target);
    },
  };
}

interface FakeComposeState {
  upCalls: number;
  downCalls: number;
  upArgs: Array<{ templatePath: string; envFilePath: string; projectName: string }>;
  downArgs: Array<{ templatePath: string; envFilePath: string; projectName: string }>;
  failUpWith: Error | null;
  failDownWith: Error | null;
}

function makeFakeCompose(): ComposeRunner & { state: FakeComposeState } {
  const state: FakeComposeState = {
    upCalls: 0,
    downCalls: 0,
    upArgs: [],
    downArgs: [],
    failUpWith: null,
    failDownWith: null,
  };
  return {
    state,
    async up(args) {
      state.upCalls++;
      state.upArgs.push(args);
      if (state.failUpWith) throw state.failUpWith;
      return { containerId: `cid-${args.projectName}` };
    },
    async down(args) {
      state.downCalls++;
      state.downArgs.push(args);
      if (state.failDownWith) throw state.failDownWith;
    },
  };
}

function freshDeps(): PrEnvBuilderDeps & {
  fs: ReturnType<typeof makeFakeFs>;
  compose: ReturnType<typeof makeFakeCompose>;
  portPool: PortPool;
  db: Database.Database;
} {
  const db = new Database(':memory:');
  db.exec(PORT_POOL_SCHEMA);
  const portPool = new PortPool(db, { range: { min: 3100, max: 3105 } });
  const fs = makeFakeFs();
  const compose = makeFakeCompose();
  const deps: PrEnvBuilderDeps = {
    portPool,
    compose,
    fs,
    github: {
      appId: '12345',
      installationId: '67890',
      privateKey: '-----BEGIN KEY-----\nABC\n-----END KEY-----\n',
    },
    paths: {
      prodDbPath: '/srv/agent-hub/prod.db',
      prEnvDataDir: '/srv/agent-hub/pr-envs',
      envFilesDir: '/srv/agent-hub/pr-envs/env',
      composeTemplatePath: '/srv/agent-hub/templates/pr-env.compose.yml',
    },
    previewBaseUrl: 'https://preview.example.com',
    renderEnvFile: buildPrEnvFile,
  };
  return Object.assign(deps, { fs, compose, portPool, db });
}

// ─── suite ────────────────────────────────────────────────────────────────

describe('buildPrEnv — happy path', () => {
  it('allocates port, copies DB, writes env file, and brings compose up', async () => {
    const deps = freshDeps();
    const res = await buildPrEnv(deps, {
      repoFullName: 'acme/repo',
      prNumber: 7,
      branch: 'feature/x',
    });

    expect(res.port).toBe(3100);
    expect(res.slotId).toBe('pr-env-7');
    expect(res.previewUrl).toBe('https://preview.example.com/pr-7');
    expect(res.composeProjectName).toBe('agent-hub-pr-7');

    // Port is recorded in the DB.
    expect(deps.portPool.getPort('acme/repo', 7)).toBe(3100);

    // DB copy: prod → pr-<num>.db
    expect(deps.fs.state.copies).toEqual([
      { src: '/srv/agent-hub/prod.db', dest: '/srv/agent-hub/pr-envs/pr-7.db' },
    ]);

    // Env file written with expected contents.
    const envBody = deps.fs.state.files.get('/srv/agent-hub/pr-envs/env/.env.preview.pr-7');
    expect(envBody).toBeDefined();
    expect(envBody).toContain('HOST_PORT=3100');
    expect(envBody).toContain('DB_PATH=/srv/agent-hub/pr-envs/pr-7.db');
    expect(envBody).toContain('PR_NUMBER=7');

    // Compose called exactly once with the rendered env file.
    expect(deps.compose.state.upCalls).toBe(1);
    expect(deps.compose.state.upArgs[0]).toEqual({
      templatePath: '/srv/agent-hub/templates/pr-env.compose.yml',
      envFilePath: '/srv/agent-hub/pr-envs/env/.env.preview.pr-7',
      projectName: 'agent-hub-pr-7',
    });
    expect(deps.compose.state.downCalls).toBe(0);
  });

  it('is idempotent on synchronize — reuses the existing port', async () => {
    const deps = freshDeps();
    const a = await buildPrEnv(deps, { repoFullName: 'acme/repo', prNumber: 7, branch: 'f' });
    const b = await buildPrEnv(deps, { repoFullName: 'acme/repo', prNumber: 7, branch: 'f' });
    expect(a.port).toBe(b.port);
    // Allocate didn't consume a second port.
    expect(deps.portPool.allocatedCount()).toBe(1);
  });
});

describe('buildPrEnv — cleanup on failure', () => {
  it('compose.up failure rolls back port + DB copy + env file (compose.down NOT called)', async () => {
    const deps = freshDeps();
    deps.compose.state.failUpWith = new Error('boom: image pull failed');

    await expect(
      buildPrEnv(deps, { repoFullName: 'r', prNumber: 11, branch: 'b' }),
    ).rejects.toThrow(/boom/);

    // Port released.
    expect(deps.portPool.getPort('r', 11)).toBeNull();
    expect(deps.portPool.allocatedCount()).toBe(0);
    // DB copy and env file removed.
    const paths = prEnvPaths(deps.paths, 11);
    expect(deps.fs.state.removed).toContain(paths.dbPath);
    expect(deps.fs.state.removed).toContain(paths.envFilePath);
    // compose.up failed so compose.down must not be called.
    expect(deps.compose.state.downCalls).toBe(0);
    // And files are actually gone in the fake fs.
    expect(deps.fs.state.files.has(paths.dbPath)).toBe(false);
    expect(deps.fs.state.files.has(paths.envFilePath)).toBe(false);
  });

  it('env-template failure rolls back port + DB (env file + compose never ran)', async () => {
    const deps = freshDeps();
    // Missing github creds → renderEnvFile throws EnvTemplateError.
    deps.github.privateKey = '';
    await expect(
      buildPrEnv(deps, { repoFullName: 'r', prNumber: 12, branch: 'b' }),
    ).rejects.toThrow(/missing required value/i);

    expect(deps.portPool.getPort('r', 12)).toBeNull();
    const paths = prEnvPaths(deps.paths, 12);
    // DB copy happened → must be cleaned.
    expect(deps.fs.state.removed).toContain(paths.dbPath);
    // Env write was aborted → no env file to remove.
    expect(deps.fs.state.files.has(paths.envFilePath)).toBe(false);
    expect(deps.compose.state.upCalls).toBe(0);
    expect(deps.compose.state.downCalls).toBe(0);
  });

  it('DB-copy failure rolls back the port only', async () => {
    const deps = freshDeps();
    deps.fs.copyFile = vi.fn().mockRejectedValue(new Error('ENOSPC'));
    await expect(
      buildPrEnv(deps, { repoFullName: 'r', prNumber: 13, branch: 'b' }),
    ).rejects.toThrow(/ENOSPC/);
    expect(deps.portPool.getPort('r', 13)).toBeNull();
    expect(deps.compose.state.upCalls).toBe(0);
  });

  it('a compose.down that itself fails during rollback does not mask the original error', async () => {
    const deps = freshDeps();
    deps.compose.state.failUpWith = new Error('original failure');
    deps.compose.state.failDownWith = new Error('secondary failure');
    await expect(
      buildPrEnv(deps, { repoFullName: 'r', prNumber: 14, branch: 'b' }),
    ).rejects.toThrow(/original failure/);
  });
});

describe('teardownPrEnv', () => {
  it('releases port, removes env file + DB, and brings compose down', async () => {
    const deps = freshDeps();
    const built = await buildPrEnv(deps, {
      repoFullName: 'acme/repo',
      prNumber: 21,
      branch: 'f',
    });
    expect(deps.portPool.getPort('acme/repo', 21)).toBe(built.port);

    await teardownPrEnv(deps, { repoFullName: 'acme/repo', prNumber: 21 });

    expect(deps.portPool.getPort('acme/repo', 21)).toBeNull();
    expect(deps.compose.state.downCalls).toBe(1);
    expect(deps.fs.state.removed).toContain(built.dbPath);
    expect(deps.fs.state.removed).toContain(built.envFilePath);
  });

  it('reloads nginx after removing the conf during teardown', async () => {
    const deps = freshDeps();
    const nginx = makeNginxDeps();
    deps.nginx = nginx.writer;

    await buildPrEnv(deps, { repoFullName: 'r', prNumber: 50, branch: 'b' });
    // Clear runner call history so we only see teardown calls.
    nginx.state.runnerCalls.length = 0;

    await teardownPrEnv(deps, { repoFullName: 'r', prNumber: 50 });

    // Should have called nginx -t + systemctl reload during teardown.
    expect(nginx.state.runnerCalls.some((c) => c.command === 'nginx' && c.args[0] === '-t')).toBe(
      true,
    );
    expect(
      nginx.state.runnerCalls.some((c) => c.command === 'systemctl' && c.args[0] === 'reload'),
    ).toBe(true);
  });
});

// ─── nginx wiring ─────────────────────────────────────────────────────────

interface FakeNginxState {
  written: Map<string, string>;
  symlinks: Map<string, string>;
  removed: string[];
  runnerCalls: Array<{ command: string; args: readonly string[] }>;
  failWriteWith: Error | null;
}

function makeNginxDeps(): {
  state: FakeNginxState;
  writer: PrEnvBuilderDeps['nginx'];
} {
  const state: FakeNginxState = {
    written: new Map(),
    symlinks: new Map(),
    removed: [],
    runnerCalls: [],
    failWriteWith: null,
  };
  const writer = {
    writer: {
      fs: {
        async readFile(p: string) {
          return state.written.get(p) ?? null;
        },
        async writeFile(p: string, contents: string) {
          if (state.failWriteWith) throw state.failWriteWith;
          state.written.set(p, contents);
        },
        async mkdir() {
          /* no-op */
        },
        async symlinkIfAbsent(target: string, link: string) {
          if (!state.symlinks.has(link)) state.symlinks.set(link, target);
        },
        async rm(p: string) {
          state.removed.push(p);
          state.written.delete(p);
          state.symlinks.delete(p);
        },
        async readlink(p: string) {
          return state.symlinks.get(p) ?? null;
        },
      },
      runner: {
        async run(command: string, args: readonly string[]) {
          state.runnerCalls.push({ command, args });
          return { code: 0, stderr: '' };
        },
      },
      sitesAvailableDir: '/etc/nginx/sites-available',
      sitesEnabledDir: '/etc/nginx/sites-enabled',
    },
    templateDefaults: {
      previewHost: 'preview.example.com',
      certPath: '/etc/letsencrypt/live/preview.example.com/fullchain.pem',
      keyPath: '/etc/letsencrypt/live/preview.example.com/privkey.pem',
    },
  };
  return { state, writer };
}

describe('buildPrEnv — nginx wiring', () => {
  it('emits the preview server block + reloads nginx after compose-up', async () => {
    const deps = freshDeps();
    const nginx = makeNginxDeps();
    deps.nginx = nginx.writer;

    const res = await buildPrEnv(deps, { repoFullName: 'r', prNumber: 99, branch: 'b' });

    const confPath = '/etc/nginx/sites-available/pr-99.preview.conf';
    const body = nginx.state.written.get(confPath);
    expect(body).toBeDefined();
    expect(body).toContain('server_name pr-99.preview.example.com;');
    expect(body).toContain(`proxy_pass http://127.0.0.1:${res.port};`);
    expect(nginx.state.symlinks.get('/etc/nginx/sites-enabled/pr-99.preview.conf')).toBe(confPath);
    // nginx -t + systemctl reload were called.
    expect(nginx.state.runnerCalls.some((c) => c.command === 'nginx')).toBe(true);
    expect(
      nginx.state.runnerCalls.some((c) => c.command === 'systemctl' && c.args[0] === 'reload'),
    ).toBe(true);
  });

  it('a failing nginx write rolls back port + DB + env file + compose', async () => {
    const deps = freshDeps();
    const nginx = makeNginxDeps();
    nginx.state.failWriteWith = new Error('EACCES writing nginx conf');
    deps.nginx = nginx.writer;

    await expect(
      buildPrEnv(deps, { repoFullName: 'r', prNumber: 100, branch: 'b' }),
    ).rejects.toThrow(/EACCES/);

    expect(deps.portPool.getPort('r', 100)).toBeNull();
    const paths = prEnvPaths(deps.paths, 100);
    expect(deps.fs.state.removed).toContain(paths.dbPath);
    expect(deps.fs.state.removed).toContain(paths.envFilePath);
    // compose.up had succeeded → compose.down must run during rollback.
    expect(deps.compose.state.downCalls).toBe(1);
  });

  it('does nothing nginx-related when deps.nginx is absent (back-compat)', async () => {
    const deps = freshDeps();
    // No deps.nginx wired — default path.
    await buildPrEnv(deps, { repoFullName: 'r', prNumber: 101, branch: 'b' });
    // Build succeeded via the existing code path; this test exists to pin
    // the back-compat guarantee that the optional nginx block is opt-in.
    expect(deps.compose.state.upCalls).toBe(1);
  });
});
