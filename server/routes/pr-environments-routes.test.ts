/**
 * PR environment routes: `/pulls/:number/preview/{start,stop,state}`, mounted
 * on a bare express app with a real service over an in-memory DB. The runtime,
 * the deploy.yaml probe, and the hosted-repo head lookup are mocked; nothing
 * boots.
 */
import '../test/setup.js';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controls for the hosted-repo head lookup the native start route performs.
const hosted = vi.hoisted(() => ({
  exists: false,
  revParse: null as null | ((repo: string, ref: string) => Promise<string | null>),
}));
vi.mock('../native-pr/host.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../native-pr/host.js')>()),
  hostedRepoExists: () => hosted.exists,
}));
vi.mock('../native-pr/git-read.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../native-pr/git-read.js')>();
  return {
    ...actual,
    revParse: (repo: string, ref: string) =>
      hosted.revParse ? hosted.revParse(repo, ref) : actual.revParse(repo, ref),
  };
});
import createPullsNativeRoutes from './pulls-native.js';
import { PR_ENVIRONMENTS_SCHEMA } from '../preview/pr-environments-schema.js';
import {
  createOrgScopedPrEnvironmentService,
  createPrEnvironmentService,
  createPrEnvironmentStore,
} from '../preview/pr-environments.js';
import { readNativePrState } from '../preview/pr-environment-native.js';
import type { RouteDeps } from '../types.js';

beforeEach(() => {
  hosted.exists = false;
  hosted.revParse = null;
});

const SHA = 'd'.repeat(40);
const SHA2 = 'e'.repeat(40);

function setup(
  opts: {
    hasConfig?: boolean;
    prStatus?: string;
    presentPrEnvironment?: RouteDeps['presentPrEnvironment'];
    readGithubPrState?: RouteDeps['readGithubPrState'];
  } = {},
) {
  const db = new Database(':memory:');
  db.exec(PR_ENVIRONMENTS_SCHEMA);
  const runtime = { build: vi.fn(), teardown: vi.fn() };
  const probe = vi
    .fn<(...args: unknown[]) => Promise<'present' | 'absent' | 'unresolved'>>()
    .mockResolvedValue((opts.hasConfig ?? true) ? 'present' : 'absent');
  const projects: Record<string, any> = {
    hosted: { id: 'hosted', gitHost: 'agenthub' },
    bare: { id: 'bare' },
    gh: { id: 'gh', githubRepo: 'acme/app' },
  };
  const prRow = {
    number: 5,
    head_branch: 'fix/hand-named',
    head_sha: SHA,
    status: opts.prStatus ?? 'open',
  };
  const stmts = {
    getPullRequestByNumber: {
      get: vi.fn((_p: string, n: number) => (n === 5 ? prRow : undefined)),
    },
  };
  const service = createOrgScopedPrEnvironmentService({
    currentOrg: () => ({
      key: db,
      db,
      stmts,
      findProject: (id: string) => projects[id] ?? null,
    }),
    create: (o) =>
      createPrEnvironmentService({
        store: createPrEnvironmentStore(o.db),
        probePreviewConfig: probe,
        findProject: o.findProject,
        getRuntime: () => runtime,
        log: () => {},
      }),
  });
  const deps = {
    findProject: (id: string) => projects[id] ?? null,
    getProjects: () => Object.values(projects),
    nativePr: {} as any,
    prEnvironments: service,
    stmts,
    broadcast: vi.fn(),
    config: {},
    presentPrEnvironment: opts.presentPrEnvironment,
    readGithubPrState: opts.readGithubPrState,
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json());
  app.use(createPullsNativeRoutes(deps));
  return { app, runtime, service, deps, probe, prRow };
}

describe('native PR environment routes', () => {
  it('serves the public wildcard URL, never the runner upstream', async () => {
    const { presentPrEnvironmentUrl } = await import('../preview/pr-environment-proxy.js');
    const { app, runtime } = setup({
      presentPrEnvironment: (env) =>
        presentPrEnvironmentUrl(
          env,
          'preview.agenthub.example.com',
          'https://agenthub.example.com',
        ),
    });
    await request(app).post('/api/projects/hosted/pulls/5/preview/start').send({});
    await new Promise((r) => setTimeout(r, 0));
    const reporter = runtime.build.mock.calls[0]![0].reporter;
    reporter.building('ref-1');
    reporter.ready('http://10.0.3.7:41234');

    const state = await request(app).get('/api/projects/hosted/pulls/5/preview/state');
    expect(state.body.environment).toMatchObject({
      status: 'ready',
      url: 'https://pr-5--hosted.preview.agenthub.example.com/',
    });
    expect(JSON.stringify(state.body)).not.toContain('10.0.3.7');
  });

  it('start queues an env for a hand-named head branch (no session involved)', async () => {
    const { app, runtime } = setup();
    const res = await request(app).post('/api/projects/hosted/pulls/5/preview/start').send({});
    expect(res.status).toBe(200);
    expect(res.body.environment).toMatchObject({
      source: 'native',
      prNumber: 5,
      headSha: SHA,
      headBranch: 'fix/hand-named',
      status: 'queued',
      logTail: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(runtime.build).toHaveBeenCalledTimes(1);

    const state = await request(app).get('/api/projects/hosted/pulls/5/preview/state');
    expect(state.body.environment.status).toBe('queued');
  });

  it('start 409s for a closed PR and for a head without a preview block', async () => {
    const closed = setup({ prStatus: 'merged' });
    const r1 = await request(closed.app).post('/api/projects/hosted/pulls/5/preview/start');
    expect(r1.status).toBe(409);
    expect(r1.body.error).toMatch(/open pull request/);

    const noConfig = setup({ hasConfig: false });
    const r2 = await request(noConfig.app).post('/api/projects/hosted/pulls/5/preview/start');
    expect(r2.status).toBe(409);
    expect(r2.body.error).toMatch(/preview:/);
  });

  it('a PR closed while the start route awaits its head lookup is not rebuilt', async () => {
    const { app, runtime, service, prRow } = setup();
    await request(app).post('/api/projects/hosted/pulls/5/preview/start');
    await request(app).post('/api/projects/hosted/pulls/5/preview/stop');
    await new Promise((r) => setTimeout(r, 0));
    expect(runtime.build).toHaveBeenCalledTimes(1);

    let release!: (sha: string | null) => void;
    hosted.exists = true;
    hosted.revParse = vi.fn(() => new Promise<string | null>((r) => (release = r)));

    const startReq = request(app)
      .post('/api/projects/hosted/pulls/5/preview/start')
      .then((r) => r);
    await vi.waitFor(() => expect(hosted.revParse).toHaveBeenCalled());

    // The PR closes; the close hook reconciles behind the pending start.
    (prRow as { status: string }).status = 'closed';
    const project = { id: 'hosted', gitHost: 'agenthub' } as any;
    const closing = service.reconcile(project, { source: 'native', prNumber: 5 }, () =>
      readNativePrState({ getPr: () => prRow as any, revParseHead: async () => SHA }, 'hosted', 5),
    );
    release(SHA2);

    const res = await startReq;
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/open pull request/);
    expect(await closing).toMatchObject({ status: 'stopped', stopReason: 'closed' });
    await new Promise((r) => setTimeout(r, 0));
    expect(runtime.build).toHaveBeenCalledTimes(1);
  });

  it('stop tears down and is idempotent', async () => {
    const { app, runtime } = setup();
    await request(app).post('/api/projects/hosted/pulls/5/preview/start');
    const first = await request(app).post('/api/projects/hosted/pulls/5/preview/stop');
    expect(first.body).toMatchObject({ ok: true, stopped: true });
    expect(first.body.environment).toMatchObject({ status: 'stopped', stopReason: 'manual' });
    expect(runtime.teardown).toHaveBeenCalledTimes(1);
    const again = await request(app).post('/api/projects/hosted/pulls/5/preview/stop');
    expect(again.body).toMatchObject({ ok: true, stopped: false });
    expect(runtime.teardown).toHaveBeenCalledTimes(1);
  });

  it('state is null for a PR that never had an env; 404 for an unknown PR; 400 for a non-hosted project', async () => {
    const { app } = setup();
    expect((await request(app).get('/api/projects/hosted/pulls/5/preview/state')).body).toEqual({
      environment: null,
    });
    expect((await request(app).get('/api/projects/hosted/pulls/99/preview/state')).status).toBe(
      404,
    );
    expect((await request(app).get('/api/projects/bare/pulls/5/preview/state')).status).toBe(400);
    expect((await request(app).get('/api/projects/nope/pulls/5/preview/state')).status).toBe(404);
  });
});

describe('GitHub-hosted PR environment routes', () => {
  it('starts from GitHub PR state, reports it, and stops it', async () => {
    const readGithubPrState = vi.fn(async () => ({
      status: 'open' as const,
      headSha: SHA,
      headBranch: 'feature/x',
    }));
    const { app, runtime } = setup({ readGithubPrState });
    const start = await request(app).post('/api/projects/gh/pulls/12/preview/start').send({});
    expect(start.status).toBe(200);
    expect(start.body.environment).toMatchObject({
      source: 'github',
      prNumber: 12,
      headSha: SHA,
      status: 'queued',
    });
    expect(readGithubPrState).toHaveBeenCalledWith(expect.objectContaining({ id: 'gh' }), 12);
    await new Promise((r) => setTimeout(r, 0));
    expect(runtime.build).toHaveBeenCalledTimes(1);

    const state = await request(app).get('/api/projects/gh/pulls/12/preview/state');
    expect(state.body.environment).toMatchObject({ source: 'github', prNumber: 12 });

    const stop = await request(app).post('/api/projects/gh/pulls/12/preview/stop');
    expect(stop.body).toMatchObject({ ok: true, stopped: true });
  });

  it('refuses a closed GitHub PR and a project without a GitHub repo', async () => {
    const { app } = setup({ readGithubPrState: async () => ({ status: 'merged' as const }) });
    const closed = await request(app).post('/api/projects/gh/pulls/12/preview/start').send({});
    expect(closed.status).toBe(409);
    const bare = await request(app).post('/api/projects/bare/pulls/12/preview/start').send({});
    expect(bare.status).toBe(400);
  });
});
