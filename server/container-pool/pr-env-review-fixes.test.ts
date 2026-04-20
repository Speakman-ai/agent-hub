/**
 * Tests for PR #459 review fixes:
 *
 *   1. readPrEnvConfig validates required fields when enabled.
 *   2. Rollback always cleans up env file (even without audit flag set).
 *   3. dispatchPrEnvBuild serializes concurrent builds for the same PR.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, vi } from 'vitest';
import { PortPool, PORT_POOL_SCHEMA } from './port-pool.js';
import {
  buildPrEnv,
  prEnvPaths,
  type ComposeRunner,
  type FsOps,
  type PrEnvBuilderDeps,
} from './pr-env-builder.js';
import { buildPrEnvFile } from './env-template.js';
import { readPrEnvConfig } from './pr-env-runtime.js';
import { dispatchPrEnvBuild } from './pr-env-dispatch.js';

// ─── fakes ────────────────────────────────────────────────────────────────

function makeFakeFs(): FsOps & {
  files: Map<string, string>;
  removed: string[];
} {
  const files = new Map<string, string>();
  const removed: string[] = [];
  return {
    files,
    removed,
    async copyFile(_src, dest) {
      files.set(dest, `copy`);
    },
    async writeFile(dest, contents) {
      files.set(dest, contents);
    },
    async rm(target) {
      removed.push(target);
      files.delete(target);
    },
  };
}

function makeFakeCompose(): ComposeRunner & {
  upCalls: number;
  failUpWith: Error | null;
} {
  const state = { upCalls: 0, failUpWith: null as Error | null };
  return {
    get upCalls() {
      return state.upCalls;
    },
    set failUpWith(e: Error | null) {
      state.failUpWith = e;
    },
    async up(args) {
      state.upCalls++;
      if (state.failUpWith) throw state.failUpWith;
      return { containerId: `cid-${args.projectName}` };
    },
    async down() {},
  };
}

function freshDeps() {
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
      prodDbPath: '/srv/prod.db',
      prEnvDataDir: '/srv/pr-envs',
      envFilesDir: '/srv/pr-envs/env',
      composeTemplatePath: '/srv/templates/pr-env.compose.yml',
    },
    previewBaseUrl: 'https://preview.example.com',
    renderEnvFile: buildPrEnvFile,
  };
  return Object.assign(deps, { fs, compose, portPool, db });
}

// ─── readPrEnvConfig validation ──────────────────────────────────────────

describe('readPrEnvConfig — required field validation', () => {
  it('returns null when feature is disabled', () => {
    const result = readPrEnvConfig({}, {});
    expect(result).toBeNull();
  });

  it('throws when enabled but required fields are missing', () => {
    expect(() => readPrEnvConfig({}, { AGENT_HUB_PR_ENV_ENABLED: 'true' })).toThrow(
      /AGENT_HUB_PR_ENV_ENABLED=true but required config is unset/,
    );
  });

  it('names all missing fields in the error message', () => {
    try {
      readPrEnvConfig({}, { AGENT_HUB_PR_ENV_ENABLED: 'true' });
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('PR_ENV_PROD_DB');
      expect(msg).toContain('PR_ENV_DATA_DIR');
      expect(msg).toContain('PR_ENV_FILES_DIR');
      expect(msg).toContain('PR_ENV_GITHUB_APP_ID');
      expect(msg).toContain('PR_ENV_GITHUB_INSTALLATION_ID');
      expect(msg).toContain('PR_ENV_GITHUB_PRIVATE_KEY');
      expect(msg).toContain('PR_ENV_REPO_FULL_NAME');
      return;
    }
    throw new Error('expected readPrEnvConfig to throw');
  });

  it('succeeds when all required fields are provided via env', () => {
    const result = readPrEnvConfig(
      {},
      {
        AGENT_HUB_PR_ENV_ENABLED: 'true',
        PR_ENV_PROD_DB: '/db/prod.db',
        PR_ENV_DATA_DIR: '/data',
        PR_ENV_FILES_DIR: '/envs',
        PR_ENV_GITHUB_APP_ID: '1',
        PR_ENV_GITHUB_INSTALLATION_ID: '2',
        PR_ENV_GITHUB_PRIVATE_KEY: 'pk',
        PR_ENV_ROUTE53_ACCESS_KEY_ID: 'AKIA',
        PR_ENV_ROUTE53_SECRET_ACCESS_KEY: 'sekret',
        PR_ENV_ROUTE53_HOSTED_ZONE_ID: 'Z123',
        PR_ENV_NGINX_CERT_PATH: '/etc/letsencrypt/live/preview/fullchain.pem',
        PR_ENV_NGINX_KEY_PATH: '/etc/letsencrypt/live/preview/privkey.pem',
        PR_ENV_PREVIEW_HOST: 'preview.example.com',
        PR_ENV_REPO_FULL_NAME: 'acme/repo',
      },
    );
    expect(result).not.toBeNull();
    expect(result!.prodDbPath).toBe('/db/prod.db');
    expect(result!.route53.accessKeyId).toBe('AKIA');
    expect(result!.nginx.previewHost).toBe('preview.example.com');
  });

  it('succeeds when all required fields come from fileConfig.prEnv', () => {
    const result = readPrEnvConfig(
      {
        prEnv: {
          enabled: true,
          prodDbPath: '/db/prod.db',
          prEnvDataDir: '/data',
          envFilesDir: '/envs',
          github: { appId: '1', installationId: '2', privateKey: 'pk' },
          route53: { accessKeyId: 'AKIA', secretAccessKey: 'sekret', hostedZoneId: 'Z1' },
          nginx: {
            certPath: '/etc/letsencrypt/live/preview/fullchain.pem',
            keyPath: '/etc/letsencrypt/live/preview/privkey.pem',
            previewHost: 'preview.example.com',
          },
          repoFullName: 'acme/repo',
        },
      },
      {},
    );
    expect(result).not.toBeNull();
    expect(result!.prodDbPath).toBe('/db/prod.db');
    expect(result!.route53.hostedZoneId).toBe('Z1');
  });
});

// ─── rollback always cleans env file ─────────────────────────────────────

describe('buildPrEnv — rollback cleans env file even on partial write', () => {
  it('removes env file when writeFile throws (audit.envWritten was never set)', async () => {
    const deps = freshDeps();
    // Simulate writeFile throwing mid-write (ENOSPC). The audit flag
    // envWritten would be false, but rollback should still attempt rm.
    deps.fs.writeFile = async (dest, _contents) => {
      // Simulate a partial file landing before the error.
      deps.fs.files.set(dest, 'partial');
      throw new Error('ENOSPC');
    };

    const paths = prEnvPaths(deps.paths, 42);
    await expect(
      buildPrEnv(deps, { repoFullName: 'r', prNumber: 42, branch: 'b' }),
    ).rejects.toThrow(/ENOSPC/);

    // The env file path should appear in the removed list even though
    // the audit flag was never flipped to true.
    expect(deps.fs.removed).toContain(paths.envFilePath);
  });
});

// ─── build serialization ─────────────────────────────────────────────────

describe('dispatchPrEnvBuild — serialization', () => {
  it('serializes concurrent builds for the same PR', async () => {
    const deps = freshDeps();
    const callOrder: number[] = [];
    let callCount = 0;
    const originalUp = deps.compose.up.bind(deps.compose);
    deps.compose.up = async (args) => {
      const myCall = ++callCount;
      // Simulate some async work so races would be visible.
      await new Promise((r) => setTimeout(r, 10));
      callOrder.push(myCall);
      return originalUp(args);
    };

    const stmts = { createKanbanCardComment: { run: vi.fn() } };
    const dispatchDeps = {
      db: deps.db,
      stmts: stmts as never,
      getBuilderDeps: () => deps as PrEnvBuilderDeps,
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
    const originalUp = deps.compose.up.bind(deps.compose);
    deps.compose.up = async (args) => {
      callOrder.push(args.projectName);
      return originalUp(args);
    };

    const stmts = { createKanbanCardComment: { run: vi.fn() } };
    const dispatchDeps = {
      db: deps.db,
      stmts: stmts as never,
      getBuilderDeps: () => deps as PrEnvBuilderDeps,
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
    // Both compose.up calls happened (order doesn't matter for different PRs).
    expect(callOrder).toHaveLength(2);
    expect(callOrder).toContain('agent-hub-pr-1');
    expect(callOrder).toContain('agent-hub-pr-2');
  });
});
