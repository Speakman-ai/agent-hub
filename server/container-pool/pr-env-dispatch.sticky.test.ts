/**
 * Integration tests covering the sticky-comment side-effect of
 * dispatchPrEnvBuild / dispatchPrEnvTeardown. The pure body builder and
 * upsert logic live in pr-sticky-comment.test.ts; here we verify the
 * dispatch path actually invokes them with the right parameters and
 * swallows transport errors.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, vi } from 'vitest';
import { PortPool, PORT_POOL_SCHEMA } from './port-pool.js';
import {
  type ContainerRunner,
  type FsOps,
  type GitOps,
  type PrEnvBuilderDeps,
} from './pr-env-builder.js';
import {
  dispatchPrEnvBuild,
  dispatchPrEnvTeardown,
  __resetPrEnvDispatchInflightForTests,
  type PrEnvProjectResolution,
} from './pr-env-dispatch.js';
import {
  STICKY_MARKER_START,
  type GitHubApiClient,
  type GitHubIssueComment,
} from './pr-sticky-comment.js';
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

function makeFakeFs(): FsOps {
  return {
    async mkdirP() {},
    async rmDir() {},
  };
}

function makeFakeGit(): GitOps {
  return {
    async cloneOrUpdate() {},
  };
}

function makeFakeContainer(opts: { failRun?: boolean } = {}): ContainerRunner {
  return {
    async build({ imageTag, defaultBaseImage, dockerfilePath }) {
      return { imageTag: dockerfilePath ? imageTag : defaultBaseImage };
    },
    async run({ containerName }) {
      if (opts.failRun) throw new Error('container run failed');
      return { containerId: `cid-${containerName}` };
    },
    async stop() {},
  };
}

function freshDeps(opts: { failRun?: boolean } = {}) {
  const db = new Database(':memory:');
  db.exec(PORT_POOL_SCHEMA);
  const portPool = new PortPool(db, { range: { min: 3100, max: 3105 } });
  const builder: PrEnvBuilderDeps = {
    portPool,
    container: makeFakeContainer(opts),
    git: makeFakeGit(),
    fs: makeFakeFs(),
    github: {
      appId: '1',
      installationId: '2',
      privateKey: 'pk',
    },
    getCloneToken: async () => 'token',
    paths: {
      checkoutBaseDir: '/srv/pr-envs',
    },
    defaultBaseImage: 'node:20',
    previewBaseUrl: 'https://preview.example.com',
  };
  return { builder, db };
}

interface RecordedCall {
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  body?: unknown;
}

function makeRecordingClient(opts: {
  listResponse?: GitHubIssueComment[];
  postId?: number;
  throwOn?: 'GET' | 'POST' | 'PATCH';
}): GitHubApiClient & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async get(path) {
      calls.push({ method: 'GET', path });
      if (opts.throwOn === 'GET') throw new Error('boom-get');
      return opts.listResponse ?? [];
    },
    async post(path, body) {
      calls.push({ method: 'POST', path, body });
      if (opts.throwOn === 'POST') throw new Error('boom-post');
      return { id: opts.postId ?? 1 };
    },
    async patch(path, body) {
      calls.push({ method: 'PATCH', path, body });
      if (opts.throwOn === 'PATCH') throw new Error('boom-patch');
      return {};
    },
  };
}

describe('dispatchPrEnvBuild → sticky comment', () => {
  it('upserts a "ready" sticky comment on a successful build', async () => {
    const { builder, db } = freshDeps();
    const client = makeRecordingClient({ listResponse: [] });
    const stmts = { createKanbanCardComment: { run: vi.fn() } };

    await dispatchPrEnvBuild(
      {
        db,
        stmts: stmts as never,
        getBuilderDeps: () => builder,
        getProjectConfig: () => FIXTURE_PROJECT,
        githubApiClientFactory: () => client,
      },
      { repoFullName: 'acme/repo', prNumber: 12, branch: 'feat/x', commitSha: 'cafebabedeadbeef' },
    );

    // Should have listed comments + posted a new one.
    expect(client.calls.find((c) => c.method === 'GET')?.path).toBe(
      '/repos/acme/repo/issues/12/comments?per_page=100',
    );
    const post = client.calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe('/repos/acme/repo/issues/12/comments');
    const body = (post?.body as { body: string }).body;
    expect(body).toContain(STICKY_MARKER_START);
    expect(body).toContain('Preview environment ready');
    expect(body).toContain('https://preview.example.com');
    expect(body).toContain('cafebab'); // 7-char sha prefix
  });

  it('PATCHes the existing sticky comment instead of creating a duplicate', async () => {
    const { builder, db } = freshDeps();
    const existing: GitHubIssueComment = {
      id: 555,
      body: `${STICKY_MARKER_START}\nstale\n<!-- agent-hub:preview-env:end -->`,
    };
    const client = makeRecordingClient({ listResponse: [existing] });
    const stmts = { createKanbanCardComment: { run: vi.fn() } };

    await dispatchPrEnvBuild(
      {
        db,
        stmts: stmts as never,
        getBuilderDeps: () => builder,
        getProjectConfig: () => FIXTURE_PROJECT,
        githubApiClientFactory: () => client,
      },
      { repoFullName: 'acme/repo', prNumber: 12, branch: 'feat/x' },
    );

    expect(client.calls.find((c) => c.method === 'POST')).toBeUndefined();
    const patch = client.calls.find((c) => c.method === 'PATCH');
    expect(patch?.path).toBe('/repos/acme/repo/issues/comments/555');
    const body = (patch?.body as { body: string }).body;
    expect(body).toContain(STICKY_MARKER_START);
    expect(body).toContain('Preview environment ready');
  });

  it('upserts a "failed" sticky comment when the build throws', async () => {
    const { builder, db } = freshDeps({ failRun: true });
    const client = makeRecordingClient({ listResponse: [] });
    const stmts = { createKanbanCardComment: { run: vi.fn() } };

    await dispatchPrEnvBuild(
      {
        db,
        stmts: stmts as never,
        getBuilderDeps: () => builder,
        getProjectConfig: () => FIXTURE_PROJECT,
        githubApiClientFactory: () => client,
      },
      { repoFullName: 'acme/repo', prNumber: 12, branch: 'feat/x' },
    );

    const post = client.calls.find((c) => c.method === 'POST');
    expect(post).toBeDefined();
    const body = (post?.body as { body: string }).body;
    expect(body).toContain('build failed');
    expect(body).toContain('container run failed');
  });

  it('swallows GitHub API errors without breaking the build path', async () => {
    const { builder, db } = freshDeps();
    const client = makeRecordingClient({ throwOn: 'POST' });
    const stmts = { createKanbanCardComment: { run: vi.fn() } };

    // dispatchPrEnvBuild must still resolve to a build result even when
    // the sticky-comment upsert blows up.
    const result = await dispatchPrEnvBuild(
      {
        db,
        stmts: stmts as never,
        getBuilderDeps: () => builder,
        getProjectConfig: () => FIXTURE_PROJECT,
        githubApiClientFactory: () => client,
      },
      { repoFullName: 'acme/repo', prNumber: 12, branch: 'feat/x' },
    );

    expect(result).not.toBeNull();
    expect(result?.previewUrl).toContain('https://');
  });

  it('skips the sticky comment when GitHub App creds are blank', async () => {
    const { builder, db } = freshDeps();
    builder.github = { appId: '', installationId: '', privateKey: '' };
    const client = makeRecordingClient({ listResponse: [] });
    const stmts = { createKanbanCardComment: { run: vi.fn() } };

    await dispatchPrEnvBuild(
      {
        db,
        stmts: stmts as never,
        getBuilderDeps: () => builder,
        getProjectConfig: () => FIXTURE_PROJECT,
        githubApiClientFactory: () => client,
      },
      { repoFullName: 'acme/repo', prNumber: 12, branch: 'feat/x' },
    );

    expect(client.calls).toHaveLength(0);
  });

  it('skips when repoFullName is malformed (missing slash)', async () => {
    const { builder, db } = freshDeps();
    const client = makeRecordingClient({ listResponse: [] });
    const stmts = { createKanbanCardComment: { run: vi.fn() } };

    await dispatchPrEnvBuild(
      {
        db,
        stmts: stmts as never,
        getBuilderDeps: () => builder,
        getProjectConfig: () => FIXTURE_PROJECT,
        githubApiClientFactory: () => client,
      },
      { repoFullName: 'no-slash-here', prNumber: 12, branch: 'feat/x' },
    );

    expect(client.calls).toHaveLength(0);
  });

  it('upserts a "failed" sticky comment when the per-project concurrency cap is exceeded, without consuming a port', async () => {
    __resetPrEnvDispatchInflightForTests();
    const { builder, db } = freshDeps();
    const client = makeRecordingClient({ listResponse: [] });
    const stmts = { createKanbanCardComment: { run: vi.fn() } };

    // Park one in-flight build to fill the cap=1 slot.
    let releaseRun!: () => void;
    const runHold = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const originalRun = builder.container.run.bind(builder.container);
    builder.container.run = async (args) => {
      await runHold;
      return originalRun(args);
    };

    const dispatchDeps = {
      db,
      stmts: stmts as never,
      getBuilderDeps: () => builder,
      getProjectConfig: () => FIXTURE_PROJECT,
      githubApiClientFactory: () => client,
      maxConcurrentBuildsPerProject: 1,
    };

    const parked = dispatchPrEnvBuild(dispatchDeps, {
      repoFullName: 'acme/repo',
      prNumber: 1,
      branch: 'a',
    });
    // Yield so the parked build registers in inflightByProject and
    // reserves its port.
    await Promise.resolve();
    await Promise.resolve();
    const portsAfterParked = builder.portPool.allocatedCount();

    // Second PR — over the cap → should reject without ever calling
    // container.run (still parked) and without allocating a new port.
    const card = { id: 'card-2' } as never;
    const rejected = await dispatchPrEnvBuild(dispatchDeps, {
      repoFullName: 'acme/repo',
      prNumber: 2,
      branch: 'b',
      card,
    });
    expect(rejected).toBeNull();
    expect(builder.portPool.allocatedCount()).toBe(portsAfterParked);

    // A "failed" sticky comment must have been posted to the GitHub PR
    // for the rejected PR (#2), not the parked one.
    const post = client.calls.find(
      (c) => c.method === 'POST' && c.path === '/repos/acme/repo/issues/2/comments',
    );
    expect(post).toBeDefined();
    const body = (post?.body as { body: string }).body;
    expect(body).toContain('build failed');
    expect(body).toMatch(/concurrency cap/i);

    // And the kanban card got the same failure surfaced.
    expect(stmts.createKanbanCardComment.run).toHaveBeenCalledTimes(1);

    releaseRun();
    await parked;
  });

  it('skips entirely when no project config is registered for the repo', async () => {
    const { builder, db } = freshDeps();
    const client = makeRecordingClient({ listResponse: [] });
    const stmts = { createKanbanCardComment: { run: vi.fn() } };

    const res = await dispatchPrEnvBuild(
      {
        db,
        stmts: stmts as never,
        getBuilderDeps: () => builder,
        getProjectConfig: () => null,
        githubApiClientFactory: () => client,
      },
      { repoFullName: 'acme/repo', prNumber: 12, branch: 'feat/x' },
    );

    expect(res).toBeNull();
    expect(client.calls).toHaveLength(0);
  });
});

describe('dispatchPrEnvTeardown → sticky comment', () => {
  it('upserts a "torndown" sticky comment on close/merge', async () => {
    const { builder, db } = freshDeps();
    const existing: GitHubIssueComment = {
      id: 777,
      body: `${STICKY_MARKER_START}\nready\n<!-- agent-hub:preview-env:end -->`,
    };
    const client = makeRecordingClient({ listResponse: [existing] });
    const stmts = { createKanbanCardComment: { run: vi.fn() } };

    await dispatchPrEnvTeardown(
      {
        db,
        stmts: stmts as never,
        getBuilderDeps: () => builder,
        getProjectConfig: () => FIXTURE_PROJECT,
        githubApiClientFactory: () => client,
      },
      { repoFullName: 'acme/repo', prNumber: 12 },
    );

    const patch = client.calls.find((c) => c.method === 'PATCH');
    expect(patch?.path).toBe('/repos/acme/repo/issues/comments/777');
    const body = (patch?.body as { body: string }).body;
    expect(body).toContain('torn down');
  });
});
