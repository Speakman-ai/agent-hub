import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { RouteDeps } from '../types.js';

vi.mock('../pr-detail-fetch.js', () => ({ fetchPrDetail: vi.fn() }));
vi.mock('../pr-read-fetch.js', () => ({ fetchPrDiff: vi.fn() }));
vi.mock('./pr-list.js', () => ({
  parseRepoFullName: (value: string) => (value ? { owner: 'owner', repo: 'repo' } : null),
  resolveUserToken: vi.fn(),
}));
vi.mock('../effective-model.js', () => ({ resolveEffectiveModel: () => 'sonnet' }));
vi.mock('../session-ownership.js', () => ({
  resolveOwnerUserId: () => 'user-1',
  setSessionOwner: vi.fn(),
}));
vi.mock('../session-checkpoint-rewind.js', () => ({ broadcastSessionCreated: vi.fn() }));

import createRoutes from './pr-review-session.js';
import { fetchPrDetail } from '../pr-detail-fetch.js';
import { fetchPrDiff } from '../pr-read-fetch.js';
import { resolveUserToken } from './pr-list.js';
import { setSessionOwner } from '../session-ownership.js';
import { broadcastSessionCreated } from '../session-checkpoint-rewind.js';
import { isNonShippingSessionBehavior } from '../session-mode.js';

function setup() {
  const project = { id: 'p1', githubRepo: 'owner/repo', agents: [{ id: 'a1', role: 'dev' }] };
  const stmts = Object.fromEntries(
    ['createSession', 'updateSessionMode', 'updateSessionFinalizeAutomation', 'deleteSession'].map(
      (name) => [name, { run: vi.fn() }],
    ),
  );
  const deps = {
    config: {},
    findProject: vi.fn(() => project),
    stmts: { ...stmts, getSession: { get: vi.fn(() => ({ id: 'session' })) } },
    broadcast: vi.fn(),
    handleChat: vi.fn(async (_ws, msg) => {
      msg._onUserMessagePersisted(true);
    }),
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json(), createRoutes(deps));
  return { deps, app, project };
}
const endpoint = '/api/projects/p1/pulls/42/review-session';

describe('GitHub PR review sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveUserToken).mockResolvedValue('user-token');
    vi.mocked(fetchPrDetail).mockResolvedValue({
      source: 'user-oauth',
      headSha: 'abc123',
      pr: { number: 42, title: 'Fix bug', body: 'PR description', head: 'feature', base: 'main' },
      reviews: [{ body: 'Earlier finding' }],
      comments: [{ body: 'Context' }],
      checks: [{ conclusion: 'failure' }],
    });
    vi.mocked(fetchPrDiff).mockResolvedValue({
      source: 'user-oauth',
      diff: 'diff --git a/x b/x\n+change',
    });
  });

  it('seeds an owned, non-shipping session with the snapshot and diff using only read fetchers', async () => {
    const { app, deps } = setup();
    const response = await request(app).post(endpoint).send({ agentId: 'a1' });
    expect(response.status).toBe(201);
    const id = response.body.sessionId;
    expect(deps.stmts.createSession.run).toHaveBeenCalledWith(
      id,
      'a1',
      expect.stringContaining('PR Review #42'),
      'claude-code',
      'sonnet',
      0,
      0,
      1,
    );
    expect(deps.stmts.updateSessionMode.run).toHaveBeenCalledWith('consult', id);
    expect(isNonShippingSessionBehavior({ session_mode: 'consult' })).toBe(true);
    expect(deps.stmts.updateSessionFinalizeAutomation.run).toHaveBeenCalledWith('manual', id);
    expect(setSessionOwner).toHaveBeenCalledWith(id, 'user-1');
    expect(fetchPrDetail).toHaveBeenCalledWith({}, { owner: 'owner', repo: 'repo' }, 42, {
      userAccessToken: 'user-token',
    });
    expect(fetchPrDiff).toHaveBeenCalledWith({}, { owner: 'owner', repo: 'repo' }, 42, {
      userAccessToken: 'user-token',
    });
    const prompt = vi.mocked(deps.handleChat).mock.calls[0][1].content;
    for (const text of [
      'PR description',
      'Earlier finding',
      'Context',
      'abc123',
      '+change',
      'failure',
      'Do not edit code, commit, push, merge, or post anything to GitHub',
      'Do not run Finalize',
      'untrusted data',
    ])
      expect(prompt).toContain(text);
    expect(prompt).not.toContain('gh pr checkout');
    expect(broadcastSessionCreated).toHaveBeenCalledOnce();
  });

  it.each(['0', '-1', '42suffix'])('rejects invalid PR number %s', async (number) => {
    const { app, deps } = setup();
    expect(
      (await request(app).post(endpoint.replace('42', number)).send({ agentId: 'a1' })).status,
    ).toBe(400);
    expect(deps.handleChat).not.toHaveBeenCalled();
  });

  it('rejects agents outside the project before fetching GitHub', async () => {
    const { app } = setup();
    expect(
      (await request(app).post(endpoint).send({ agentId: 'other-project-agent' })).status,
    ).toBe(404);
    expect(fetchPrDetail).not.toHaveBeenCalled();
  });

  it('requires the requesting user to connect GitHub', async () => {
    vi.mocked(resolveUserToken).mockResolvedValue(null);
    const { app, deps } = setup();
    expect((await request(app).post(endpoint).send({ agentId: 'a1' })).status).toBe(412);
    expect(deps.stmts.createSession.run).not.toHaveBeenCalled();
  });

  it('does not start a session when fetching the diff fails', async () => {
    vi.mocked(fetchPrDiff).mockRejectedValueOnce(new Error('GitHub unavailable'));
    const { app, deps } = setup();
    expect((await request(app).post(endpoint).send({ agentId: 'a1' })).status).toBe(502);
    expect(deps.stmts.createSession.run).not.toHaveBeenCalled();
  });

  it('removes an unseeded session instead of returning an empty chat', async () => {
    const { app, deps } = setup();
    vi.mocked(deps.handleChat).mockImplementationOnce(async (_ws, msg) => {
      msg._onUserMessagePersisted?.(false);
    });
    expect((await request(app).post(endpoint).send({ agentId: 'a1' })).status).toBe(502);
    expect(deps.stmts.deleteSession.run).toHaveBeenCalledOnce();
    expect(broadcastSessionCreated).not.toHaveBeenCalled();
  });

  it('marks truncated context so the review cannot silently claim full coverage', async () => {
    vi.mocked(fetchPrDiff).mockResolvedValueOnce({
      source: 'user-oauth',
      diff: 'x'.repeat(100_001),
    });
    const { app, deps } = setup();
    expect((await request(app).post(endpoint).send({ agentId: 'a1' })).status).toBe(201);
    expect(vi.mocked(deps.handleChat).mock.calls[0][1].content).toContain('Context truncated');
  });
});
