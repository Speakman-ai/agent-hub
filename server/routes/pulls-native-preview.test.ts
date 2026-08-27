/**
 * PR-scoped preview routes — successful orchestration paths.
 *
 * These mount `createPullsNativeRoutes` on a bare express app with fully
 * mocked deps so we exercise the real session-resolution + route wiring
 * WITHOUT the live app and WITHOUT spawning a preview process. The preview
 * runtime and `startSessionPreview` are stubbed; the head-branch → session
 * resolver (`resolveSessionForPrHeadBranch`) runs for real against the fake
 * statements.
 *
 * The negative/guard paths (no-session 409, not-hosted 400, unknown-PR 404)
 * are covered against the live app in `pulls-native.test.ts`; here we cover
 * the successful start, state, and stop paths the reviewer flagged.
 */
import '../test/setup.js';
import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the preview surface so success paths never touch the real runtime.
vi.mock('../preview/start-session-preview.js', () => ({
  startSessionPreview: vi.fn(),
}));
vi.mock('../preview/get-session-preview-state.js', () => ({
  getSessionPreviewStateEvent: vi.fn(),
}));

import createPullsNativeRoutes from './pulls-native.js';
import { startSessionPreview } from '../preview/start-session-preview.js';
import { getSessionPreviewStateEvent } from '../preview/get-session-preview-state.js';
import type { RouteDeps } from '../types.js';

// The PR's head branch is the session's canonical branch:
// agent-hub/<agent_id>/session-<first8-of-id>.
const AGENT_ID = 'dev';
const HEAD_BRANCH = 'agent-hub/dev/session-abcd1234';
const SESSION_ID = 'abcd1234-0000-4000-8000-000000000001';
const PROJECT_ID = 'p1';

function makeDeps(over: Record<string, any> = {}) {
  const runtime = {
    stopBySessionId: vi.fn().mockResolvedValue(1),
    getActiveBySessionId: vi.fn(),
    getLogTail: vi.fn().mockReturnValue([]),
  };
  const prRow = { number: 5, head_branch: HEAD_BRANCH, status: 'open' };
  const sessionRow = { id: SESSION_ID, deleted_at: null, agent_id: AGENT_ID };
  const stmts = {
    getPullRequestByNumber: { get: vi.fn().mockReturnValue(prRow) },
    // `.all` returns every session sharing the 8-hex prefix.
    getSessionByIdPrefix: {
      all: vi.fn((prefix: string) => (prefix === 'abcd1234' ? [sessionRow] : [])),
    },
    getSession: { get: vi.fn().mockReturnValue(sessionRow) },
  };
  const deps = {
    findProject: vi.fn().mockReturnValue({ id: PROJECT_ID, gitHost: 'agenthub' }),
    nativePr: {} as any,
    stmts,
    broadcast: vi.fn(),
    // Maps the session's agent back to its project — the tenant-scope check.
    findAgent: vi.fn((agentId: string) =>
      agentId === AGENT_ID ? { project: { id: PROJECT_ID }, agent: { id: AGENT_ID } } : null,
    ),
    getDevServerRuntime: () => runtime,
    config: { publicUrl: 'https://hub.example.com', previewSubdomainBase: null },
    ...over,
  };
  return { deps: deps as unknown as RouteDeps, runtime, stmts, prRow, sessionRow };
}

function appFor(deps: RouteDeps) {
  const app = express();
  app.use(express.json());
  app.use(createPullsNativeRoutes(deps));
  return app;
}

beforeEach(() => {
  (startSessionPreview as any).mockReset();
  (getSessionPreviewStateEvent as any).mockReset();
});

describe('POST /pulls/:number/preview/start', () => {
  it('resolves the session, calls startSessionPreview, returns the payload', async () => {
    const { deps } = makeDeps();
    (startSessionPreview as any).mockResolvedValue({ ok: true, started: true });

    const res = await request(appFor(deps))
      .post('/api/projects/p1/pulls/5/preview/start')
      .send({})
      .expect(200);

    expect(res.body).toEqual({ ok: true, started: true, sessionId: SESSION_ID });
    expect(startSessionPreview).toHaveBeenCalledTimes(1);
    const arg = (startSessionPreview as any).mock.calls[0][0];
    expect(arg.sessionId).toBe(SESSION_ID);
    expect(arg.body).toEqual({ route: undefined, reason: 'PR #5 preview' });
    expect(arg.routing).toEqual({
      publicUrl: 'https://hub.example.com',
      subdomainBase: null,
    });
    expect(typeof arg.getSession).toBe('function');
    expect(typeof arg.findAgent).toBe('function');
  });

  it('forwards a caller-supplied route + reason', async () => {
    const { deps } = makeDeps();
    (startSessionPreview as any).mockResolvedValue({ ok: true, started: true });

    await request(appFor(deps))
      .post('/api/projects/p1/pulls/5/preview/start')
      .send({ route: '/dashboard', reason: 'custom' })
      .expect(200);

    const arg = (startSessionPreview as any).mock.calls[0][0];
    expect(arg.body).toEqual({ route: '/dashboard', reason: 'custom' });
  });

  it('409s (open-only) for a merged PR and never calls startSessionPreview', async () => {
    const { deps } = makeDeps();
    deps.stmts.getPullRequestByNumber.get = vi.fn().mockReturnValue({
      number: 5,
      head_branch: HEAD_BRANCH,
      status: 'merged',
    }) as any;
    (startSessionPreview as any).mockResolvedValue({ ok: true, started: true });

    const res = await request(appFor(deps))
      .post('/api/projects/p1/pulls/5/preview/start')
      .send({})
      .expect(409);
    expect(res.body.error).toMatch(/only be started for an open pull request/i);
    expect(startSessionPreview).not.toHaveBeenCalled();
  });

  it('forwards a startSessionPreview failure with its status code', async () => {
    const { deps } = makeDeps();
    (startSessionPreview as any).mockResolvedValue({
      ok: false,
      error: 'Session workspace not ready',
      statusCode: 409,
    });

    const res = await request(appFor(deps))
      .post('/api/projects/p1/pulls/5/preview/start')
      .send({})
      .expect(409);
    expect(res.body).toEqual({ error: 'Session workspace not ready' });
  });
});

describe('GET /pulls/:number/preview/state', () => {
  it('returns the resolved session id and the snapshot event', async () => {
    const { deps } = makeDeps();
    const event = { type: 'agenthub_preview', kind: 'preview', previewUrl: '/proxy' };
    (getSessionPreviewStateEvent as any).mockReturnValue(event);

    const res = await request(appFor(deps))
      .get('/api/projects/p1/pulls/5/preview/state')
      .expect(200);

    expect(res.body).toEqual({ sessionId: SESSION_ID, preview: event });
    expect(getSessionPreviewStateEvent).toHaveBeenCalledTimes(1);
    expect((getSessionPreviewStateEvent as any).mock.calls[0][1]).toBe(SESSION_ID);
  });

  it('returns preview:null (not an error) when no session backs the branch', async () => {
    const { deps, stmts } = makeDeps();
    stmts.getPullRequestByNumber.get.mockReturnValue({
      number: 5,
      head_branch: 'release-2.1', // encodes no session
      status: 'open',
    });

    const res = await request(appFor(deps))
      .get('/api/projects/p1/pulls/5/preview/state')
      .expect(200);
    expect(res.body).toEqual({ sessionId: null, preview: null });
    expect(getSessionPreviewStateEvent).not.toHaveBeenCalled();
  });
});

describe('POST /pulls/:number/preview/stop', () => {
  it('stops the resolved session preview and broadcasts preview_stopped', async () => {
    const { deps, runtime } = makeDeps();

    const res = await request(appFor(deps))
      .post('/api/projects/p1/pulls/5/preview/stop')
      .send({})
      .expect(200);

    expect(res.body).toEqual({ ok: true, stopped: 1, sessionId: SESSION_ID });
    expect(runtime.stopBySessionId).toHaveBeenCalledWith(SESSION_ID);
    expect(deps.broadcast).toHaveBeenCalledWith({
      type: 'agenthub_preview',
      kind: 'preview_stopped',
      sessionId: SESSION_ID,
    });
  });

  it('is idempotent — stopped:0 when nothing was running', async () => {
    const { deps, runtime } = makeDeps();
    runtime.stopBySessionId.mockResolvedValue(0);

    const res = await request(appFor(deps))
      .post('/api/projects/p1/pulls/5/preview/stop')
      .send({})
      .expect(200);
    expect(res.body).toEqual({ ok: true, stopped: 0, sessionId: SESSION_ID });
  });
});

describe('preview session resolution is tenant- and identity-scoped', () => {
  it('start 409s when the prefix-matched session belongs to another project', async () => {
    const { deps, runtime } = makeDeps({
      // Same 8-hex + same canonical branch, but the session's agent maps to a
      // DIFFERENT project. It must not resolve for project p1.
      findAgent: vi.fn(() => ({ project: { id: 'other-tenant' }, agent: { id: AGENT_ID } })),
    });
    (startSessionPreview as any).mockResolvedValue({ ok: true, started: true });

    const res = await request(appFor(deps))
      .post('/api/projects/p1/pulls/5/preview/start')
      .send({})
      .expect(409);
    expect(res.body.error).toMatch(/no live session worktree/i);
    expect(startSessionPreview).not.toHaveBeenCalled();
    expect(runtime.stopBySessionId).not.toHaveBeenCalled();
  });

  it('start 409s on an 8-hex prefix collision whose full canonical branch differs', async () => {
    const { deps } = makeDeps();
    // Same prefix, DIFFERENT agent id → canonical branch is
    // agent-hub/evil/session-abcd1234, which is not the PR head branch.
    deps.stmts.getSessionByIdPrefix.all = vi.fn(() => [
      { id: SESSION_ID, deleted_at: null, agent_id: 'evil' },
    ]) as any;
    (startSessionPreview as any).mockResolvedValue({ ok: true, started: true });

    const res = await request(appFor(deps))
      .post('/api/projects/p1/pulls/5/preview/start')
      .send({})
      .expect(409);
    expect(res.body.error).toMatch(/no live session worktree/i);
    expect(startSessionPreview).not.toHaveBeenCalled();
  });

  it('stop 409s (and never touches the runtime) for a cross-tenant prefix match', async () => {
    const { deps, runtime } = makeDeps({
      findAgent: vi.fn(() => ({ project: { id: 'other-tenant' }, agent: { id: AGENT_ID } })),
    });

    await request(appFor(deps)).post('/api/projects/p1/pulls/5/preview/stop').send({}).expect(409);
    expect(runtime.stopBySessionId).not.toHaveBeenCalled();
    expect(deps.broadcast).not.toHaveBeenCalled();
  });
});
