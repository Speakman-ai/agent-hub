import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { RouteDeps } from '../types.js';
import type { PrEnvironmentDto } from '../preview/pr-environments.js';

vi.mock('../pr-detail-fetch.js', () => ({ fetchPrDetail: vi.fn() }));
vi.mock('./pr-list.js', () => ({
  parseRepoFullName: (value: string) => (value ? { owner: 'owner', repo: 'repo' } : null),
  resolveUserToken: vi.fn(),
}));
vi.mock('../effective-model.js', () => ({
  resolveAgentSpawnEngineAndModel: () => ({ engine: 'claude-code', model: 'sonnet' }),
}));
vi.mock('../session-ownership.js', () => ({
  resolveOwnerUserId: () => 'user-1',
  setSessionOwner: vi.fn(),
}));
vi.mock('../session-checkpoint-rewind.js', () => ({ broadcastSessionCreated: vi.fn() }));

import createRoutes, { buildPrEnvironmentSection } from './pr-discuss.js';
import { fetchPrDetail } from '../pr-detail-fetch.js';
import { resolveUserToken } from './pr-list.js';
import { setSessionOwner } from '../session-ownership.js';

function env(overrides: Partial<PrEnvironmentDto> = {}): PrEnvironmentDto {
  return {
    id: 'env-1',
    projectId: 'p1',
    source: 'native',
    prNumber: 42,
    headSha: 'abc123abc123ffff',
    headBranch: 'feature',
    status: 'ready',
    url: 'https://pr-42--p1.preview.example.com/',
    error: null,
    stopReason: null,
    runnerRef: null,
    ...overrides,
  } as PrEnvironmentDto;
}

const nativeDetail = {
  source: 'agenthub',
  pr: {
    number: 42,
    title: 'Add widget',
    body: 'Adds a widget. The page now loads in under a second.',
    head: 'feature',
    base: 'main',
    head_sha: 'abc123abc123ffff',
  },
  reviews: [],
  comments: [{ user: 'ana', body: 'Does the widget render on mobile?' }],
  checks: [],
};

function setup(
  opts: {
    gitHost?: string;
    environment?: PrEnvironmentDto | null;
    organizationWorkspace?: boolean;
    agentProjectId?: string;
  } = {},
) {
  const project = {
    id: 'p1',
    gitHost: opts.gitHost ?? 'agenthub',
    githubRepo: opts.gitHost === 'github' ? 'owner/repo' : undefined,
    workspaceKind: opts.organizationWorkspace ? 'organization' : undefined,
  };
  const stmts = Object.fromEntries(
    [
      'createSession',
      'setSessionResolvePrHeadBranch',
      'updateSessionFinalizeAutomation',
      'insertBackgroundTask',
      'deleteSession',
    ].map((name) => [name, { run: vi.fn() }]),
  );
  const handleChat = vi.fn(
    async (_ws: unknown, msg: { _onUserMessagePersisted?: (ok: boolean) => void }) => {
      msg._onUserMessagePersisted?.(true);
    },
  );
  const deps = {
    config: {},
    findProject: vi.fn(() => project),
    findAgent: vi.fn(() => ({
      project: { id: opts.agentProjectId ?? 'p1' },
      agent: { id: 'a1', role: 'dev' },
    })),
    nativePr: { getDetail: vi.fn().mockResolvedValue(nativeDetail) },
    prEnvironments: { get: vi.fn(() => opts.environment ?? null) },
    presentPrEnvironment: (e: PrEnvironmentDto) => e,
    stmts: { ...stmts, getSession: { get: vi.fn(() => ({ id: 'session' })) } },
    broadcast: vi.fn(),
    handleChat,
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json(), createRoutes(deps));
  return { deps, app, handleChat };
}

const endpoint = '/api/projects/p1/pulls/42/discuss';
const seededPrompt = (handleChat: ReturnType<typeof vi.fn>): string =>
  (handleChat.mock.calls[0]![1] as { content: string }).content;

describe('POST /pulls/:number/discuss', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens a normal owned session on the PR head branch with the PR context', async () => {
    const { app, deps, handleChat } = setup();
    const res = await request(app).post(endpoint).send({ agentId: 'a1' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ agentId: 'a1', hasEnvironment: false });
    const id = res.body.sessionId;
    expect(deps.stmts.createSession.run).toHaveBeenCalledWith(
      id,
      'a1',
      '[Discuss PR #42] Add widget',
      'claude-code',
      'sonnet',
      1,
      0,
      1,
    );
    expect(setSessionOwner).toHaveBeenCalledWith(id, 'user-1');
    expect(deps.stmts.setSessionResolvePrHeadBranch.run).toHaveBeenCalledWith('feature', id);
    // A normal session: no background task, no forced push automation.
    expect(deps.stmts.insertBackgroundTask.run).not.toHaveBeenCalled();
    expect(deps.stmts.updateSessionFinalizeAutomation.run).not.toHaveBeenCalled();

    const prompt = seededPrompt(handleChat);
    expect(prompt).toContain('discuss PR #42');
    expect(prompt).toContain('page now loads in under a second');
    expect(prompt).toContain('Does the widget render on mobile?');
    expect(prompt).toContain('git diff origin/main...HEAD');
    expect(prompt).not.toContain('## PR environment');
  });

  it('tells the agent about a ready PR environment so it can validate claims', async () => {
    const { app, handleChat } = setup({ environment: env() });
    const res = await request(app).post(endpoint).send({ agentId: 'a1' });

    expect(res.status).toBe(201);
    expect(res.body.hasEnvironment).toBe(true);
    const prompt = seededPrompt(handleChat);
    expect(prompt).toContain('## PR environment');
    expect(prompt).toContain('https://pr-42--p1.preview.example.com/');
    expect(prompt).toContain('validate claims');
    expect(prompt).toContain('/api/projects/p1/pulls/42/preview/share-links');
  });

  it('looks up GitHub-hosted environments by the github source', async () => {
    vi.mocked(resolveUserToken).mockResolvedValue('tok');
    vi.mocked(fetchPrDetail).mockResolvedValue({
      ...nativeDetail,
      source: 'user-oauth',
      headSha: 'abc123abc123ffff',
    } as never);
    const { app, deps } = setup({ gitHost: 'github', environment: env({ source: 'github' }) });
    const res = await request(app).post(endpoint).send({ agentId: 'a1' });

    expect(res.status).toBe(201);
    expect(deps.prEnvironments!.get).toHaveBeenCalledWith('p1', {
      source: 'github',
      prNumber: 42,
    });
    expect(fetchPrDetail).toHaveBeenCalled();
  });

  it('refuses organization workspaces, which cannot check out the PR head', async () => {
    const { app, deps, handleChat } = setup({ organizationWorkspace: true });
    const res = await request(app).post(endpoint).send({ agentId: 'a1' });
    expect(res.status).toBe(400);
    expect(deps.stmts.createSession.run).not.toHaveBeenCalled();
    expect(handleChat).not.toHaveBeenCalled();
  });

  it('refuses a PR with no head branch instead of seeding an unrelated checkout', async () => {
    const { app, deps, handleChat } = setup();
    vi.mocked(deps.nativePr!.getDetail).mockResolvedValueOnce({
      ...nativeDetail,
      pr: { ...nativeDetail.pr, head: '' },
    } as never);
    const res = await request(app).post(endpoint).send({ agentId: 'a1' });
    expect(res.status).toBe(409);
    expect(deps.stmts.createSession.run).not.toHaveBeenCalled();
    expect(handleChat).not.toHaveBeenCalled();
  });

  it('rejects a missing agentId and an agent from another project', async () => {
    const { app } = setup();
    expect((await request(app).post(endpoint).send({})).status).toBe(400);
    const other = setup({ agentProjectId: 'p2' });
    expect((await request(other.app).post(endpoint).send({ agentId: 'a1' })).status).toBe(404);
  });

  it('maps a missing PR to 404 and creates no session', async () => {
    const { app, deps } = setup();
    vi.mocked(deps.nativePr!.getDetail).mockRejectedValueOnce(new Error('PR #42 not found'));
    const res = await request(app).post(endpoint).send({ agentId: 'a1' });
    expect(res.status).toBe(404);
    expect(deps.stmts.createSession.run).not.toHaveBeenCalled();
  });

  it('deletes the session when the seed turn is not accepted', async () => {
    const { app, deps, handleChat } = setup();
    handleChat.mockImplementationOnce(async (_ws, msg) => {
      msg._onUserMessagePersisted?.(false);
    });
    const res = await request(app).post(endpoint).send({ agentId: 'a1' });
    expect(res.status).toBe(502);
    expect(deps.stmts.deleteSession.run).toHaveBeenCalled();
  });
});

describe('buildPrEnvironmentSection', () => {
  const ctx = { projectId: 'p1', prNumber: 42, prHeadSha: 'abc123abc123ffff' };

  it('returns null with no environment or a stopped one', () => {
    expect(buildPrEnvironmentSection(null, ctx)).toBeNull();
    expect(buildPrEnvironmentSection(env({ status: 'stopped' }), ctx)).toBeNull();
  });

  it('points a loopback environment at Bash, not the browser tool', () => {
    const section = buildPrEnvironmentSection(env({ url: 'http://localhost:4123' }), ctx)!;
    expect(section).toContain('curl -sS http://localhost:4123');
    expect(section).not.toContain('share-links');
  });

  it('warns when the environment was built from an older commit', () => {
    const section = buildPrEnvironmentSection(env({ headSha: 'old000old000' }), ctx)!;
    expect(section).toContain('may not include the latest commits');
  });

  it('describes a building environment as not usable yet', () => {
    const section = buildPrEnvironmentSection(env({ status: 'building', url: null }), ctx)!;
    expect(section).toContain('being built');
    expect(section).toContain('/api/projects/p1/pulls/42/preview/state');
  });

  it('reports a failed build with its first error line', () => {
    const section = buildPrEnvironmentSection(
      env({ status: 'failed', url: null, error: 'npm ci failed\nstack…' }),
      ctx,
    )!;
    expect(section).toContain('failed: npm ci failed');
    expect(section).not.toContain('stack');
  });
});
