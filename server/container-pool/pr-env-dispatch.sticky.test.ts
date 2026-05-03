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
import { type ComposeRunner, type FsOps, type PrEnvBuilderDeps } from './pr-env-builder.js';
import { buildPrEnvFile } from './env-template.js';
import { dispatchPrEnvBuild, dispatchPrEnvTeardown } from './pr-env-dispatch.js';
import {
  STICKY_MARKER_START,
  type GitHubApiClient,
  type GitHubIssueComment,
} from './pr-sticky-comment.js';

function makeFakeFs(): FsOps {
  return {
    async copyFile() {},
    async writeFile() {},
    async rm() {},
  };
}

function makeFakeCompose(opts: { failUp?: boolean } = {}): ComposeRunner {
  return {
    async up({ projectName }) {
      if (opts.failUp) throw new Error('compose up failed');
      return { containerId: `cid-${projectName}` };
    },
    async down() {},
  };
}

function freshDeps(opts: { failUp?: boolean } = {}) {
  const db = new Database(':memory:');
  db.exec(PORT_POOL_SCHEMA);
  const portPool = new PortPool(db, { range: { min: 3100, max: 3105 } });
  const builder: PrEnvBuilderDeps = {
    portPool,
    compose: makeFakeCompose(opts),
    fs: makeFakeFs(),
    github: {
      appId: '1',
      installationId: '2',
      privateKey: 'pk',
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
    const { builder, db } = freshDeps({ failUp: true });
    const client = makeRecordingClient({ listResponse: [] });
    const stmts = { createKanbanCardComment: { run: vi.fn() } };

    await dispatchPrEnvBuild(
      {
        db,
        stmts: stmts as never,
        getBuilderDeps: () => builder,
        githubApiClientFactory: () => client,
      },
      { repoFullName: 'acme/repo', prNumber: 12, branch: 'feat/x' },
    );

    const post = client.calls.find((c) => c.method === 'POST');
    expect(post).toBeDefined();
    const body = (post?.body as { body: string }).body;
    expect(body).toContain('build failed');
    expect(body).toContain('compose up failed');
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
        githubApiClientFactory: () => client,
      },
      { repoFullName: 'no-slash-here', prNumber: 12, branch: 'feat/x' },
    );

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
