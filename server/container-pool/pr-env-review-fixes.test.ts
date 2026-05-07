/**
 * Tests for PR #459 review fixes (script-mode rewrite):
 *
 *   1. readPrEnvConfig validates required fields when enabled.
 *   2. Rollback always cleans up the checkout dir (even on partial git work).
 *   3. dispatchPrEnvBuild serializes concurrent builds for the same PR.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PortPool, PORT_POOL_SCHEMA } from './port-pool.js';
import {
  buildPrEnv,
  prEnvPaths,
  type ContainerRunner,
  type FsOps,
  type GitOps,
  type PrEnvBuilderDeps,
} from './pr-env-builder.js';
import { readPrEnvConfig } from './pr-env-runtime.js';
import {
  dispatchPrEnvBuild,
  __resetPrEnvDispatchInflightForTests,
  type PrEnvProjectResolution,
} from './pr-env-dispatch.js';
import type { PrEnvProjectConfig } from '../types.js';

const FIXTURE_PROJECT_CONFIG: PrEnvProjectConfig = {
  enabled: true,
  startScript: 'npm start',
  internalPort: 3000,
  healthPath: '/',
};

const FIXTURE_PROJECT: PrEnvProjectResolution = {
  config: FIXTURE_PROJECT_CONFIG,
  slug: 'acme-repo',
};

const APP_CONFIG = {
  githubApp: {
    appId: '1',
    installationId: 2,
    privateKey: 'pk',
  },
};

// ─── fakes ────────────────────────────────────────────────────────────────

function makeFakeFs(): FsOps & {
  dirs: Set<string>;
  removed: string[];
} {
  const dirs = new Set<string>();
  const removed: string[] = [];
  return {
    dirs,
    removed,
    async mkdirP(target) {
      dirs.add(target);
    },
    async rmDir(target) {
      removed.push(target);
      dirs.delete(target);
    },
  };
}

function makeFakeGit(): GitOps & {
  cloneCalls: number;
  failWith: Error | null;
} {
  const state = { cloneCalls: 0, failWith: null as Error | null };
  return {
    get cloneCalls() {
      return state.cloneCalls;
    },
    set failWith(e: Error | null) {
      state.failWith = e;
    },
    async cloneOrUpdate() {
      state.cloneCalls++;
      if (state.failWith) throw state.failWith;
    },
  };
}

function makeFakeContainer(): ContainerRunner & {
  buildCalls: number;
  runCalls: number;
  stopCalls: number;
} {
  const state = { buildCalls: 0, runCalls: 0, stopCalls: 0 };
  return {
    get buildCalls() {
      return state.buildCalls;
    },
    get runCalls() {
      return state.runCalls;
    },
    get stopCalls() {
      return state.stopCalls;
    },
    async build({ imageTag, defaultBaseImage, dockerfilePath }) {
      state.buildCalls++;
      return { imageTag: dockerfilePath ? imageTag : defaultBaseImage };
    },
    async run({ containerName }) {
      state.runCalls++;
      return { containerId: `cid-${containerName}` };
    },
    async stop() {
      state.stopCalls++;
    },
  };
}

function freshDeps() {
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
    getCloneToken: async () => 'token',
    paths: {
      checkoutBaseDir: '/srv/pr-envs',
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
    projectSlug: FIXTURE_PROJECT.slug,
  };
}

// ─── readPrEnvConfig validation ──────────────────────────────────────────

// A minimal file-block that turns the feature on without supplying any of
// the required fields — used to exercise the "enabled but misconfigured"
// validation path now that the env-var gate has been removed.
const ENABLED_FILE_BLOCK_ONLY = { prEnv: { enabled: true } };

describe('readPrEnvConfig — required field validation', () => {
  it('returns null when feature is disabled', () => {
    const result = readPrEnvConfig({}, {});
    expect(result).toBeNull();
  });

  it('throws when enabled but required fields are missing', () => {
    expect(() => readPrEnvConfig(ENABLED_FILE_BLOCK_ONLY, {}, null, { githubApp: null })).toThrow(
      /PR Environments are enabled but required config is unset/,
    );
  });

  it('names all missing fields in the error message', () => {
    try {
      readPrEnvConfig(ENABLED_FILE_BLOCK_ONLY, {}, null, { githubApp: null });
    } catch (e) {
      const msg = (e as Error).message;
      // GitHub creds come from the registered Reviewer App now — when
      // missing, the error names the App fields.
      expect(msg).toContain('PR_ENV_GITHUB_APP_ID');
      expect(msg).toContain('PR_ENV_GITHUB_INSTALLATION_ID');
      expect(msg).toContain('PR_ENV_GITHUB_PRIVATE_KEY');
      // `PR_ENV_REPO_FULL_NAME` is no longer required — multi-project
      // PR-envs resolve the owning repo per-event from the per-project
      // `githubRepo` field. The singleton field stays as an optional
      // reaper fallback only.
      expect(msg).not.toContain('PR_ENV_REPO_FULL_NAME');
      expect(msg).toContain('PR_ENV_NGINX_CERT_PATH');
      expect(msg).toContain('PR_ENV_PREVIEW_HOST');
      expect(msg).toContain('PR_ENV_ROUTE53_HOSTED_ZONE_ID');
      return;
    }
    throw new Error('expected readPrEnvConfig to throw');
  });

  it('succeeds when all required fields are provided via env + file-block + Reviewer App', () => {
    // The toggle itself comes from the file-block (legacy pre-migration
    // path) since there is no env-var override for `enabled` anymore.
    // Host-path / Route 53 / nginx fields still accept env overrides.
    const result = readPrEnvConfig(
      ENABLED_FILE_BLOCK_ONLY,
      {
        PR_ENV_ROUTE53_ACCESS_KEY_ID: 'AKIA',
        PR_ENV_ROUTE53_SECRET_ACCESS_KEY: 'sekret',
        PR_ENV_ROUTE53_HOSTED_ZONE_ID: 'Z123',
        PR_ENV_NGINX_CERT_PATH: '/etc/letsencrypt/live/preview/fullchain.pem',
        PR_ENV_NGINX_KEY_PATH: '/etc/letsencrypt/live/preview/privkey.pem',
        PR_ENV_PREVIEW_HOST: 'preview.example.com',
        PR_ENV_REPO_FULL_NAME: 'acme/repo',
      },
      null,
      APP_CONFIG,
    );
    expect(result).not.toBeNull();
    expect(result!.checkoutBaseDir).toContain('pr-envs');
    expect(result!.defaultBaseImage).toBe('node:20');
    expect(result!.route53.accessKeyId).toBe('AKIA');
    expect(result!.nginx.previewHost).toBe('preview.example.com');
  });

  it('lets fileBlock override checkoutBaseDir + defaultBaseImage', () => {
    const result = readPrEnvConfig(
      {
        prEnv: {
          enabled: true,
          checkoutBaseDir: '/var/lib/agent-hub/pr-envs',
          defaultBaseImage: 'node:18-alpine',
          repoFullName: 'acme/repo',
          route53: { accessKeyId: '', secretAccessKey: '', hostedZoneId: 'Z1' },
          nginx: {
            sitesAvailableDir: '/etc/nginx/sites-available',
            sitesEnabledDir: '/etc/nginx/sites-enabled',
            certPath: '/etc/letsencrypt/live/preview/fullchain.pem',
            keyPath: '/etc/letsencrypt/live/preview/privkey.pem',
            previewHost: 'preview.example.com',
            certHome: '/var/lib/acme',
          },
        },
      },
      {},
      null,
      APP_CONFIG,
    );
    expect(result).not.toBeNull();
    expect(result!.checkoutBaseDir).toBe('/var/lib/agent-hub/pr-envs');
    expect(result!.defaultBaseImage).toBe('node:18-alpine');
    expect(result!.route53.hostedZoneId).toBe('Z1');
  });

  it('env vars override fileBlock for checkoutBaseDir + defaultBaseImage', () => {
    // Regression for PR #749 review: precedence inversion — file was
    // winning over env, contradicting the docstring's env > file order.
    // An operator who set PR_ENV_CHECKOUT_BASE_DIR to override a stale
    // file value would silently get the file value back.
    const result = readPrEnvConfig(
      {
        prEnv: {
          enabled: true,
          checkoutBaseDir: '/from/file/pr-envs',
          defaultBaseImage: 'node:18-alpine',
          repoFullName: 'acme/repo',
          route53: { accessKeyId: '', secretAccessKey: '', hostedZoneId: 'Z1' },
          nginx: {
            sitesAvailableDir: '/etc/nginx/sites-available',
            sitesEnabledDir: '/etc/nginx/sites-enabled',
            certPath: '/etc/letsencrypt/live/preview/fullchain.pem',
            keyPath: '/etc/letsencrypt/live/preview/privkey.pem',
            previewHost: 'preview.example.com',
            certHome: '/var/lib/acme',
          },
        },
      },
      {
        PR_ENV_CHECKOUT_BASE_DIR: '/from/env/pr-envs',
        PR_ENV_DEFAULT_BASE_IMAGE: 'node:22',
      },
      null,
      APP_CONFIG,
    );
    expect(result).not.toBeNull();
    expect(result!.checkoutBaseDir).toBe('/from/env/pr-envs');
    expect(result!.defaultBaseImage).toBe('node:22');
  });

  it('loads dockerHostCheckoutBaseDir from env with precedence over fileBlock', () => {
    const result = readPrEnvConfig(
      {
        prEnv: {
          enabled: true,
          checkoutBaseDir: '/home/node/.agent-hub/pr-envs',
          dockerHostCheckoutBaseDir: '/from/file/host-pr-envs',
          repoFullName: 'acme/repo',
          route53: { accessKeyId: '', secretAccessKey: '', hostedZoneId: 'Z1' },
          nginx: {
            sitesAvailableDir: '/etc/nginx/sites-available',
            sitesEnabledDir: '/etc/nginx/sites-enabled',
            certPath: '/etc/letsencrypt/live/preview/fullchain.pem',
            keyPath: '/etc/letsencrypt/live/preview/privkey.pem',
            previewHost: 'preview.example.com',
            certHome: '/var/lib/acme',
          },
        },
      },
      {
        PR_ENV_DOCKER_HOST_CHECKOUT_BASE_DIR: '/from/env/host-pr-envs',
      },
      null,
      APP_CONFIG,
    );
    expect(result).not.toBeNull();
    expect(result!.checkoutBaseDir).toBe('/home/node/.agent-hub/pr-envs');
    expect(result!.dockerHostCheckoutBaseDir).toBe('/from/env/host-pr-envs');
  });
});

// ─── rollback always cleans checkout dir ─────────────────────────────────

describe('buildPrEnv — rollback cleans checkout even on partial git work', () => {
  it('removes checkout dir when git.cloneOrUpdate throws partway through', async () => {
    const deps = freshDeps();
    // Simulate git failing after creating a partial tree.
    deps.git.failWith = new Error('fatal: bad object');

    const paths = prEnvPaths(deps.paths, FIXTURE_PROJECT.slug, 42);
    await expect(buildPrEnv(deps, buildRequest(42, 'r'))).rejects.toThrow(/bad object/);

    // The checkout dir should appear in the removed list — rmDir is
    // tolerant of ENOENT, so calling it on a partial tree (or no tree
    // at all) is safe.
    expect(deps.fs.removed).toContain(paths.checkoutDir);
  });
});

// ─── build serialization ─────────────────────────────────────────────────

describe('dispatchPrEnvBuild — serialization', () => {
  beforeEach(() => {
    __resetPrEnvDispatchInflightForTests();
  });

  it('serializes concurrent builds for the same PR', async () => {
    const deps = freshDeps();
    const callOrder: number[] = [];
    let callCount = 0;
    const originalRun = deps.container.run.bind(deps.container);
    deps.container.run = async (args) => {
      const myCall = ++callCount;
      // Simulate some async work so races would be visible.
      await new Promise((r) => setTimeout(r, 10));
      callOrder.push(myCall);
      return originalRun(args);
    };

    const stmts = { createKanbanCardComment: { run: vi.fn() } };
    const dispatchDeps = {
      db: deps.db,
      stmts: stmts as never,
      getBuilderDeps: () => deps as PrEnvBuilderDeps,
      getProjectConfig: () => FIXTURE_PROJECT,
    };

    // Fire two builds concurrently for the same PR.
    const [a, b] = await Promise.all([
      dispatchPrEnvBuild(dispatchDeps, {
        repoFullName: 'acme/repo',
        prNumber: 5,
        branch: 'f',
      }),
      dispatchPrEnvBuild(dispatchDeps, {
        repoFullName: 'acme/repo',
        prNumber: 5,
        branch: 'f',
      }),
    ]);

    // Both should succeed (port is idempotent).
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Builds ran sequentially: call 1 finished before call 2 started.
    expect(callOrder).toEqual([1, 2]);
  });

  it('allows concurrent builds for different PRs', async () => {
    const deps = freshDeps();
    const callOrder: string[] = [];
    const originalRun = deps.container.run.bind(deps.container);
    deps.container.run = async (args) => {
      callOrder.push(args.containerName);
      return originalRun(args);
    };

    const stmts = { createKanbanCardComment: { run: vi.fn() } };
    const dispatchDeps = {
      db: deps.db,
      stmts: stmts as never,
      getBuilderDeps: () => deps as PrEnvBuilderDeps,
      getProjectConfig: () => FIXTURE_PROJECT,
    };

    // Fire builds for two different PRs concurrently.
    const [a, b] = await Promise.all([
      dispatchPrEnvBuild(dispatchDeps, {
        repoFullName: 'acme/repo',
        prNumber: 1,
        branch: 'a',
      }),
      dispatchPrEnvBuild(dispatchDeps, {
        repoFullName: 'acme/repo',
        prNumber: 2,
        branch: 'b',
      }),
    ]);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Both container.run calls happened (order doesn't matter for different PRs).
    expect(callOrder).toHaveLength(2);
    expect(callOrder).toContain(`agent-hub-pr-${FIXTURE_PROJECT.slug}-1`);
    expect(callOrder).toContain(`agent-hub-pr-${FIXTURE_PROJECT.slug}-2`);
  });
});

// ─── per-project concurrency cap ─────────────────────────────────────────

describe('dispatchPrEnvBuild — per-project concurrency cap', () => {
  beforeEach(() => {
    __resetPrEnvDispatchInflightForTests();
  });

  function makeDispatchDeps(deps: ReturnType<typeof freshDeps>, cap?: number) {
    const stmts = { createKanbanCardComment: { run: vi.fn() } };
    return {
      db: deps.db,
      stmts: stmts as never,
      getBuilderDeps: () => deps as PrEnvBuilderDeps,
      getProjectConfig: () => FIXTURE_PROJECT,
      ...(cap !== undefined ? { maxConcurrentBuildsPerProject: cap } : {}),
    };
  }

  it('rejects new builds beyond the cap and surfaces the failure on the linked card', async () => {
    const deps = freshDeps();
    // Hold container.run open so all in-flight builds stay parked.
    let releaseRun!: () => void;
    const runHold = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const originalRun = deps.container.run.bind(deps.container);
    deps.container.run = async (args) => {
      await runHold;
      return originalRun(args);
    };

    const dispatchDeps = makeDispatchDeps(deps, 2);

    // Two parked in-flight builds for two different PRs (consume both slots).
    const slot1 = dispatchPrEnvBuild(dispatchDeps, {
      repoFullName: 'acme/repo',
      prNumber: 1,
      branch: 'a',
    });
    const slot2 = dispatchPrEnvBuild(dispatchDeps, {
      repoFullName: 'acme/repo',
      prNumber: 2,
      branch: 'b',
    });
    // Yield so the parked builds register themselves in the inflight maps.
    await Promise.resolve();
    await Promise.resolve();

    // Third PR: new build → over the cap → must reject without ever
    // reaching the container runner.
    const card = { id: 'card-3' } as never;
    const rejected = await dispatchPrEnvBuild(dispatchDeps, {
      repoFullName: 'acme/repo',
      prNumber: 3,
      branch: 'c',
      card,
    });
    expect(rejected).toBeNull();

    // Surfaced via the kanban card comment with a "concurrency cap" message.
    const stmts = (
      dispatchDeps as { stmts: { createKanbanCardComment: { run: ReturnType<typeof vi.fn> } } }
    ).stmts;
    expect(stmts.createKanbanCardComment.run).toHaveBeenCalledTimes(1);
    const commentBody = stmts.createKanbanCardComment.run.mock.calls[0][3] as string;
    expect(commentBody).toMatch(/concurrency cap/i);
    expect(commentBody).toContain('2/2');

    // Release the parked builds so Promise.all resolves cleanly.
    releaseRun();
    await Promise.all([slot1, slot2]);
  });

  it('does not double-count synchronize events for an already in-flight PR', async () => {
    const deps = freshDeps();
    let releaseRun!: () => void;
    const runHold = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const originalRun = deps.container.run.bind(deps.container);
    deps.container.run = async (args) => {
      await runHold;
      return originalRun(args);
    };

    // Cap of 1 — strictest check that synchronize doesn't burn a slot.
    const dispatchDeps = makeDispatchDeps(deps, 1);

    const initial = dispatchPrEnvBuild(dispatchDeps, {
      repoFullName: 'acme/repo',
      prNumber: 7,
      branch: 'feature/x',
    });
    await Promise.resolve();
    await Promise.resolve();

    // A "synchronize" event for the same PR while the first is still in
    // flight: this must chain (serialize) onto the existing entry rather
    // than be rejected as over-cap.
    const synchronize = dispatchPrEnvBuild(dispatchDeps, {
      repoFullName: 'acme/repo',
      prNumber: 7,
      branch: 'feature/x',
    });

    // Now cap=1 is "consumed" by PR 7. A *different* PR must reject.
    const otherCard = { id: 'card-other' } as never;
    const rejected = await dispatchPrEnvBuild(dispatchDeps, {
      repoFullName: 'acme/repo',
      prNumber: 99,
      branch: 'other',
      card: otherCard,
    });
    expect(rejected).toBeNull();

    releaseRun();
    const [a, b] = await Promise.all([initial, synchronize]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it('frees the slot once a build completes', async () => {
    const deps = freshDeps();
    const dispatchDeps = makeDispatchDeps(deps, 1);

    // First build runs to completion (no parking).
    const first = await dispatchPrEnvBuild(dispatchDeps, {
      repoFullName: 'acme/repo',
      prNumber: 10,
      branch: 'a',
    });
    expect(first).not.toBeNull();

    // After completion, a new build for the same project must succeed —
    // the slot was released on cleanup.
    const second = await dispatchPrEnvBuild(dispatchDeps, {
      repoFullName: 'acme/repo',
      prNumber: 11,
      branch: 'b',
    });
    expect(second).not.toBeNull();
  });

  it('uses the default cap of 10 when none is provided in deps', async () => {
    const deps = freshDeps();
    let releaseRun!: () => void;
    const runHold = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const originalRun = deps.container.run.bind(deps.container);
    deps.container.run = async (args) => {
      await runHold;
      return originalRun(args);
    };

    // Use a generous port pool so we don't bottleneck on ports before
    // hitting the cap.
    const db = new Database(':memory:');
    db.exec(PORT_POOL_SCHEMA);
    deps.portPool = new PortPool(db, { range: { min: 4000, max: 4100 } });
    (deps as PrEnvBuilderDeps).portPool = deps.portPool;

    const dispatchDeps = makeDispatchDeps(deps); // no maxConcurrentBuildsPerProject

    // Park 10 in-flight builds for 10 distinct PRs.
    const parked = Array.from({ length: 10 }, (_, i) =>
      dispatchPrEnvBuild(dispatchDeps, {
        repoFullName: 'acme/repo',
        prNumber: i + 1,
        branch: `pr-${i + 1}`,
      }),
    );
    // Yield enough turns for all 10 to reach container.run and register.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // 11th must reject with concurrency-cap error.
    const card = { id: 'card-11' } as never;
    const rejected = await dispatchPrEnvBuild(dispatchDeps, {
      repoFullName: 'acme/repo',
      prNumber: 11,
      branch: 'pr-11',
      card,
    });
    expect(rejected).toBeNull();

    const stmts = (
      dispatchDeps as { stmts: { createKanbanCardComment: { run: ReturnType<typeof vi.fn> } } }
    ).stmts;
    const commentBody = stmts.createKanbanCardComment.run.mock.calls[0][3] as string;
    expect(commentBody).toContain('10/10');

    releaseRun();
    await Promise.all(parked);
  });
});
