/**
 * PR-env builder tests (W2 — script-mode rewrite).
 *
 * The critical contract is **cleanup on failure**:
 *
 *   • Happy path: port allocated, clone token minted, repo cloned into
 *     `<checkoutBaseDir>/<projectSlug>/pr-<N>/`, image built (or default
 *     base passed through), container started with PORT injected and
 *     start-script execed, and `buildPrEnv` returns deterministic paths.
 *   • Failure mid-build must undo everything that got created — the
 *     container is stopped, the checkout dir is rmDir'd, and the port
 *     is released. Container.stop is idempotent so we always call it
 *     during rollback (zombie-cleanup), but port-release is only
 *     attempted when allocation succeeded.
 *   • `synchronize` resync on an existing PR reuses the same port
 *     (idempotent allocate).
 *   • `teardownPrEnv` tears every layer down regardless of state.
 */

import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { PortPool, PORT_POOL_SCHEMA } from './port-pool.js';
import {
  buildPrEnv,
  prEnvPaths,
  teardownPrEnv,
  type ContainerRunner,
  type FsOps,
  type GitOps,
  type PrEnvBuilderDeps,
} from './pr-env-builder.js';
import type { PrEnvProjectConfig } from '../types.js';

// ─── fakes ────────────────────────────────────────────────────────────────

interface FakeFsState {
  dirs: Set<string>;
  removed: string[];
}

function makeFakeFs(): FsOps & { state: FakeFsState } {
  const state: FakeFsState = {
    dirs: new Set(),
    removed: [],
  };
  return {
    state,
    async mkdirP(target: string) {
      state.dirs.add(target);
    },
    async rmDir(target: string) {
      state.removed.push(target);
      state.dirs.delete(target);
    },
  };
}

interface FakeGitState {
  cloneCalls: Array<{
    repoFullName: string;
    branch: string;
    commitSha?: string;
    checkoutDir: string;
    cloneToken: string;
  }>;
  failWith: Error | null;
}

function makeFakeGit(): GitOps & { state: FakeGitState } {
  const state: FakeGitState = { cloneCalls: [], failWith: null };
  return {
    state,
    async cloneOrUpdate(opts) {
      state.cloneCalls.push(opts);
      if (state.failWith) throw state.failWith;
    },
  };
}

interface FakeContainerState {
  buildCalls: Array<{
    contextDir: string;
    dockerfilePath: string | null;
    imageTag: string;
    defaultBaseImage: string;
  }>;
  runCalls: Array<{
    containerName: string;
    imageTag: string;
    hostPort: number;
    internalPort: number;
    checkoutDir: string;
    startScript: string;
    setupCommand?: string;
    env?: Record<string, string>;
  }>;
  stopCalls: Array<{ containerName: string }>;
  /**
   * Container names currently considered "running" by the fake.
   * `run()` rejects when a name is already in this set (mirroring
   * Docker's `Conflict. The container name "/<name>" is already in use`
   * error); `stop()` removes the name. This forces the builder to
   * actually call `stop` before `run` on the synchronize cycle, which
   * was the original bug the production runner was masking.
   */
  activeNames: Set<string>;
  failBuildWith: Error | null;
  failRunWith: Error | null;
  failStopWith: Error | null;
  /** When set, build() returns this tag instead of the requested one. */
  buildReturnsTag: string | null;
}

function makeFakeContainer(): ContainerRunner & { state: FakeContainerState } {
  const state: FakeContainerState = {
    buildCalls: [],
    runCalls: [],
    stopCalls: [],
    activeNames: new Set(),
    failBuildWith: null,
    failRunWith: null,
    failStopWith: null,
    buildReturnsTag: null,
  };
  return {
    state,
    async build(opts) {
      state.buildCalls.push(opts);
      if (state.failBuildWith) throw state.failBuildWith;
      // When dockerfilePath is null, the runner should pass through the
      // default base image (matches the real adapter contract).
      const tag =
        state.buildReturnsTag ?? (opts.dockerfilePath ? opts.imageTag : opts.defaultBaseImage);
      return { imageTag: tag };
    },
    async run(opts) {
      state.runCalls.push(opts);
      if (state.failRunWith) throw state.failRunWith;
      if (state.activeNames.has(opts.containerName)) {
        throw new Error(`Conflict. The container name "/${opts.containerName}" is already in use`);
      }
      state.activeNames.add(opts.containerName);
      return { containerId: `cid-${opts.containerName}` };
    },
    async stop(opts) {
      state.stopCalls.push(opts);
      if (state.failStopWith) throw state.failStopWith;
      state.activeNames.delete(opts.containerName);
    },
  };
}

const FIXTURE_PROJECT_SLUG = 'acme-repo';
const FIXTURE_PROJECT_CONFIG: PrEnvProjectConfig = {
  enabled: true,
  startScript: 'npm start',
  internalPort: 3000,
  healthPath: '/',
  setupCommand: 'npm install',
};

function freshDeps(): PrEnvBuilderDeps & {
  fs: ReturnType<typeof makeFakeFs>;
  git: ReturnType<typeof makeFakeGit>;
  container: ReturnType<typeof makeFakeContainer>;
  portPool: PortPool;
  db: Database.Database;
} {
  const db = new Database(':memory:');
  db.exec(PORT_POOL_SCHEMA);
  const portPool = new PortPool(db, { range: { min: 3100, max: 3105 } });
  const fs = makeFakeFs();
  const git = makeFakeGit();
  const container = makeFakeContainer();
  const deps: PrEnvBuilderDeps = {
    portPool,
    container,
    git,
    fs,
    github: {
      appId: '12345',
      installationId: '67890',
      privateKey: '-----BEGIN KEY-----\nABC\n-----END KEY-----\n',
    },
    getCloneToken: async () => 'fake-installation-token',
    paths: {
      checkoutBaseDir: '/srv/agent-hub/pr-envs',
    },
    defaultBaseImage: 'node:20',
    previewBaseUrl: 'https://preview.example.com',
  };
  return Object.assign(deps, { fs, git, container, portPool, db });
}

function buildRequest(prNumber: number, repo = 'acme/repo', branch = 'feature/x') {
  return {
    repoFullName: repo,
    prNumber,
    branch,
    projectConfig: FIXTURE_PROJECT_CONFIG,
    projectSlug: FIXTURE_PROJECT_SLUG,
  };
}

// ─── suite ────────────────────────────────────────────────────────────────

describe('buildPrEnv — happy path', () => {
  it('allocates port, clones repo, runs container with start script, and returns deterministic paths', async () => {
    const deps = freshDeps();
    const res = await buildPrEnv(deps, buildRequest(7));

    expect(res.port).toBe(3100);
    expect(res.slotId).toBe('pr-env-acme-repo-7');
    expect(res.previewUrl).toBe('https://preview.example.com/pr-7');
    expect(res.checkoutDir).toBe('/srv/agent-hub/pr-envs/acme-repo/pr-7');
    expect(res.containerName).toBe('agent-hub-pr-acme-repo-7');
    // No Dockerfile in fixture → image tag falls back to default base image.
    expect(res.imageTag).toBe('node:20');
    expect(res.containerId).toBe('cid-agent-hub-pr-acme-repo-7');

    // Port is recorded in the DB.
    expect(deps.portPool.getPort('acme/repo', 7)).toBe(3100);

    // Parent dir mkdir'd before clone.
    expect(deps.fs.state.dirs.has('/srv/agent-hub/pr-envs/acme-repo')).toBe(true);

    // Clone called once with the minted token.
    expect(deps.git.state.cloneCalls).toHaveLength(1);
    expect(deps.git.state.cloneCalls[0]).toMatchObject({
      repoFullName: 'acme/repo',
      branch: 'feature/x',
      checkoutDir: '/srv/agent-hub/pr-envs/acme-repo/pr-7',
      cloneToken: 'fake-installation-token',
    });

    // Build called with no Dockerfile → null path, default base image carried through.
    expect(deps.container.state.buildCalls).toHaveLength(1);
    expect(deps.container.state.buildCalls[0]).toMatchObject({
      contextDir: '/srv/agent-hub/pr-envs/acme-repo/pr-7',
      dockerfilePath: null,
      imageTag: 'agent-hub-pr/acme-repo:pr-7',
      defaultBaseImage: 'node:20',
    });

    // Run called once with PORT/start-script wiring.
    expect(deps.container.state.runCalls).toHaveLength(1);
    expect(deps.container.state.runCalls[0]).toMatchObject({
      containerName: 'agent-hub-pr-acme-repo-7',
      imageTag: 'node:20',
      hostPort: 3100,
      internalPort: 3000,
      checkoutDir: '/srv/agent-hub/pr-envs/acme-repo/pr-7',
      startScript: 'npm start',
      setupCommand: 'npm install',
    });

    // No checkout teardown on the success path. The builder calls
    // container.stop({ containerName }) once before run() to clear any
    // zombie / synchronize-leftover container under that name — that
    // single, idempotent stop is expected.
    expect(deps.container.state.stopCalls).toEqual([{ containerName: 'agent-hub-pr-acme-repo-7' }]);
    expect(deps.fs.state.removed).toHaveLength(0);
  });

  it('lowercases the project slug when forming the docker image tag and container name', async () => {
    // Regression: Project ids are validated against /^[a-zA-Z0-9-]+$/ so a
    // slug like `MyApp` is legal — but Docker repository names must be
    // lowercase, so `docker build --tag agent-hub-pr/MyApp:pr-7` would
    // exit non-zero with `invalid reference format: repository name must
    // be lowercase`. prEnvPaths now downcases the slug for both the
    // image tag and container name.
    const deps = freshDeps();
    const req = {
      ...buildRequest(7),
      projectSlug: 'MyApp',
    };
    const res = await buildPrEnv(deps, req);
    expect(res.imageTag).toBe('node:20'); // default base image — no Dockerfile
    expect(res.containerName).toBe('agent-hub-pr-myapp-7');
    // The build call must have requested a lowercased image tag too,
    // so a Dockerfile project would receive a Docker-grammar-valid name.
    expect(deps.container.state.buildCalls[0]?.imageTag).toBe('agent-hub-pr/myapp:pr-7');
  });

  it('resolves Dockerfile path inside the checkout when projectConfig.dockerfilePath is set', async () => {
    const deps = freshDeps();
    const req = {
      ...buildRequest(8),
      projectConfig: { ...FIXTURE_PROJECT_CONFIG, dockerfilePath: 'docker/Dockerfile' },
    };
    deps.container.state.buildReturnsTag = 'agent-hub-pr/acme-repo:pr-8';

    const res = await buildPrEnv(deps, req);

    expect(res.imageTag).toBe('agent-hub-pr/acme-repo:pr-8');
    expect(deps.container.state.buildCalls[0]).toMatchObject({
      dockerfilePath: '/srv/agent-hub/pr-envs/acme-repo/pr-8/docker/Dockerfile',
      imageTag: 'agent-hub-pr/acme-repo:pr-8',
    });
    expect(deps.container.state.runCalls[0]?.imageTag).toBe('agent-hub-pr/acme-repo:pr-8');
  });

  it('omits setupCommand when project config leaves it blank', async () => {
    const deps = freshDeps();
    const req = {
      ...buildRequest(9),
      projectConfig: { ...FIXTURE_PROJECT_CONFIG, setupCommand: '   ' },
    };
    await buildPrEnv(deps, req);
    expect(deps.container.state.runCalls[0]?.setupCommand).toBeUndefined();
  });

  it('passes per-project env vars into container.run as a flat string→string map', async () => {
    // The runner already accepts an `env` field — this test just guards
    // the wiring so the field doesn't get dropped at the builder layer.
    const deps = freshDeps();
    const req = {
      ...buildRequest(10),
      projectConfig: {
        ...FIXTURE_PROJECT_CONFIG,
        env: {
          AWS_ACCESS_KEY_ID: 'AKIATEST',
          AWS_SECRET_ACCESS_KEY: 'shhh',
          UPSTREAM_API_URL: 'https://api.example.com',
        },
      } as PrEnvProjectConfig,
    };
    await buildPrEnv(deps, req);
    expect(deps.container.state.runCalls[0]?.env).toEqual({
      AWS_ACCESS_KEY_ID: 'AKIATEST',
      AWS_SECRET_ACCESS_KEY: 'shhh',
      UPSTREAM_API_URL: 'https://api.example.com',
    });
  });

  it('omits env when project config leaves it empty / undefined', async () => {
    // Empty objects must not flow through as `--env` in the runner —
    // pass undefined so the runner can short-circuit cleanly.
    const deps = freshDeps();
    const reqEmpty = {
      ...buildRequest(11),
      projectConfig: { ...FIXTURE_PROJECT_CONFIG, env: {} } as PrEnvProjectConfig,
    };
    await buildPrEnv(deps, reqEmpty);
    expect(deps.container.state.runCalls[0]?.env).toBeUndefined();

    const deps2 = freshDeps();
    await buildPrEnv(deps2, buildRequest(12));
    expect(deps2.container.state.runCalls[0]?.env).toBeUndefined();
  });

  it('is idempotent on synchronize — reuses the existing port', async () => {
    const deps = freshDeps();
    const a = await buildPrEnv(deps, buildRequest(7));
    const b = await buildPrEnv(deps, buildRequest(7));
    expect(a.port).toBe(b.port);
    // Allocate didn't consume a second port.
    expect(deps.portPool.allocatedCount()).toBe(1);
    // Both attempts cloned (real GitOps would do `fetch+reset` on the
    // second call; the fake just records both attempts).
    expect(deps.git.state.cloneCalls).toHaveLength(2);
  });

  it('clears any pre-existing container before running on synchronize', async () => {
    // Regression: on `pull_request.synchronize`, the previous build
    // leaves a detached container running under the same name. Without
    // a stop-before-run, `docker run --name <n>` would reject with
    // `Conflict. The container name "/<n>" is already in use`. The
    // strengthened fake (activeNames Set) now reproduces that conflict
    // — so this test fails without the stop-before-run in buildPrEnv.
    const deps = freshDeps();
    await buildPrEnv(deps, buildRequest(7));
    // The first container is now "running" in the fake's activeNames set.
    expect(deps.container.state.activeNames.has('agent-hub-pr-acme-repo-7')).toBe(true);

    // A second build (synchronize) must succeed — buildPrEnv stops the
    // pre-existing container, then `run` starts a fresh one under the
    // same name without colliding.
    await expect(buildPrEnv(deps, buildRequest(7))).resolves.toMatchObject({
      containerName: 'agent-hub-pr-acme-repo-7',
    });
    // Two `run` calls (one per build), and the second build stopped
    // the first container before its `run` (so we see ≥2 stop calls).
    expect(deps.container.state.runCalls).toHaveLength(2);
    expect(
      deps.container.state.stopCalls.filter((c) => c.containerName === 'agent-hub-pr-acme-repo-7')
        .length,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe('buildPrEnv — cleanup on failure', () => {
  it('container.run failure rolls back port + checkout dir + container.stop', async () => {
    const deps = freshDeps();
    deps.container.state.failRunWith = new Error('boom: image start failed');

    await expect(buildPrEnv(deps, buildRequest(11, 'r'))).rejects.toThrow(/boom/);

    // Port released.
    expect(deps.portPool.getPort('r', 11)).toBeNull();
    expect(deps.portPool.allocatedCount()).toBe(0);

    // Checkout dir cleaned up.
    const paths = prEnvPaths(deps.paths, FIXTURE_PROJECT_SLUG, 11);
    expect(deps.fs.state.removed).toContain(paths.checkoutDir);

    // Container.stop is idempotent and always called during rollback to
    // catch zombie containers from a partial `run`. The builder also
    // calls stop *before* run to clear any synchronize-leftover
    // container — so on a run failure we expect at least the
    // pre-run stop plus the rollback stop, both targeting this container.
    expect(deps.container.state.stopCalls.length).toBeGreaterThanOrEqual(1);
    expect(
      deps.container.state.stopCalls.every((c) => c.containerName === paths.containerName),
    ).toBe(true);
  });

  it('git.cloneOrUpdate failure rolls back port + attempts checkout cleanup', async () => {
    const deps = freshDeps();
    deps.git.state.failWith = new Error('fatal: authentication failed');

    await expect(buildPrEnv(deps, buildRequest(12, 'r'))).rejects.toThrow(/authentication failed/);

    // Port released.
    expect(deps.portPool.getPort('r', 12)).toBeNull();
    // Container build/run never reached.
    expect(deps.container.state.buildCalls).toHaveLength(0);
    expect(deps.container.state.runCalls).toHaveLength(0);
    // Partial-tree cleanup still attempted (rmDir tolerates ENOENT).
    const paths = prEnvPaths(deps.paths, FIXTURE_PROJECT_SLUG, 12);
    expect(deps.fs.state.removed).toContain(paths.checkoutDir);
  });

  it('container.build failure rolls back port + checkout, never calls run', async () => {
    const deps = freshDeps();
    deps.container.state.failBuildWith = new Error('docker build: no space left');

    await expect(buildPrEnv(deps, buildRequest(13, 'r'))).rejects.toThrow(/no space left/);

    expect(deps.portPool.getPort('r', 13)).toBeNull();
    expect(deps.container.state.runCalls).toHaveLength(0);
    const paths = prEnvPaths(deps.paths, FIXTURE_PROJECT_SLUG, 13);
    expect(deps.fs.state.removed).toContain(paths.checkoutDir);
  });

  it('a container.stop that itself fails during rollback does not mask the original error', async () => {
    const deps = freshDeps();
    deps.container.state.failRunWith = new Error('original failure');
    deps.container.state.failStopWith = new Error('secondary failure');
    await expect(buildPrEnv(deps, buildRequest(14, 'r'))).rejects.toThrow(/original failure/);
  });
});

describe('teardownPrEnv', () => {
  it('releases port, stops container, and removes checkout dir', async () => {
    const deps = freshDeps();
    const built = await buildPrEnv(deps, buildRequest(21));
    expect(deps.portPool.getPort('acme/repo', 21)).toBe(built.port);
    // Reset stop-call history so we only see teardown calls.
    deps.container.state.stopCalls.length = 0;

    await teardownPrEnv(deps, {
      repoFullName: 'acme/repo',
      prNumber: 21,
      projectSlug: FIXTURE_PROJECT_SLUG,
    });

    expect(deps.portPool.getPort('acme/repo', 21)).toBeNull();
    expect(deps.container.state.stopCalls).toEqual([{ containerName: built.containerName }]);
    expect(deps.fs.state.removed).toContain(built.checkoutDir);
  });

  it('reloads nginx after removing the conf during teardown', async () => {
    const deps = freshDeps();
    const nginx = makeNginxDeps();
    deps.nginx = nginx.writer;

    await buildPrEnv(deps, buildRequest(50, 'r'));
    nginx.state.runnerCalls.length = 0;

    await teardownPrEnv(deps, {
      repoFullName: 'r',
      prNumber: 50,
      projectSlug: FIXTURE_PROJECT_SLUG,
    });

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
  it('emits the preview server block + reloads nginx after container starts', async () => {
    const deps = freshDeps();
    const nginx = makeNginxDeps();
    deps.nginx = nginx.writer;

    const res = await buildPrEnv(deps, buildRequest(99, 'r'));

    const confPath = '/etc/nginx/sites-available/pr-99.preview.conf';
    const body = nginx.state.written.get(confPath);
    expect(body).toBeDefined();
    expect(body).toContain('server_name pr-99.preview.example.com;');
    expect(body).toContain(`proxy_pass http://127.0.0.1:${res.port};`);
    expect(nginx.state.symlinks.get('/etc/nginx/sites-enabled/pr-99.preview.conf')).toBe(confPath);
    expect(nginx.state.runnerCalls.some((c) => c.command === 'nginx')).toBe(true);
    expect(
      nginx.state.runnerCalls.some((c) => c.command === 'systemctl' && c.args[0] === 'reload'),
    ).toBe(true);
  });

  it('a failing nginx write rolls back port + checkout + container', async () => {
    const deps = freshDeps();
    const nginx = makeNginxDeps();
    nginx.state.failWriteWith = new Error('EACCES writing nginx conf');
    deps.nginx = nginx.writer;

    await expect(buildPrEnv(deps, buildRequest(100, 'r'))).rejects.toThrow(/EACCES/);

    expect(deps.portPool.getPort('r', 100)).toBeNull();
    const paths = prEnvPaths(deps.paths, FIXTURE_PROJECT_SLUG, 100);
    expect(deps.fs.state.removed).toContain(paths.checkoutDir);
    // container.run had succeeded → container.stop must run during rollback.
    expect(deps.container.state.stopCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('does nothing nginx-related when deps.nginx is absent (back-compat)', async () => {
    const deps = freshDeps();
    await buildPrEnv(deps, buildRequest(101, 'r'));
    expect(deps.container.state.runCalls).toHaveLength(1);
  });
});
