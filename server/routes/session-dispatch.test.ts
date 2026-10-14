/**
 * POST /api/projects/:projectId/sessions/dispatch — the route the Hub
 * assistant (and `sessions.sh dispatch`) uses to start a session on a project
 * agent. Dispatch itself is mocked; no CLI is spawned.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import type { Project, RouteDeps } from '../types.js';
import { HUB_PROJECT_ID } from '../../shared/utils/hub.js';

const mocks = vi.hoisted(() => ({ dispatch: vi.fn() }));

vi.mock('../background-agent-session.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../background-agent-session.js')>();
  return { ...real, dispatchBackgroundAgentSession: mocks.dispatch };
});

const { BackgroundSessionDispatchError } = await import('../background-agent-session.js');
const { default: createSessionDispatchRoutes, sessionNameFromPrompt } =
  await import('./session-dispatch.js');

const project = {
  id: 'web',
  name: 'Web',
  cwd: '/tmp/web',
  agents: [{ id: 'web-dev', name: 'Web Dev', role: 'dev', engine: 'claude-code' }],
} as unknown as Project;
const hubProject = {
  id: HUB_PROJECT_ID,
  name: 'Hub',
  kind: 'system',
  agents: [],
} as unknown as Project;

const sessions: Record<string, { id: string; owner_user_id: string | null }> = {
  'hub-sess': { id: 'hub-sess', owner_user_id: 'owner-1' },
};

function mount(auth: Record<string, unknown>): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    Object.assign(req, auth);
    next();
  });
  app.use(
    createSessionDispatchRoutes({
      findProject: (id: string) =>
        id === 'web' ? project : id === HUB_PROJECT_ID ? hubProject : null,
      stmts: { getSession: { get: (id: string) => sessions[id] } },
    } as unknown as RouteDeps),
  );
  return app;
}

const asUser = { authUserId: 'user-1', authUser: 'alice', authRole: 'Owner' };
const asGlobalKey = { authViaApiKey: true, authRole: 'Owner' };

beforeEach(() => {
  mocks.dispatch.mockReset();
  mocks.dispatch.mockReturnValue({ sessionId: 'new-sess', agentId: 'web-dev', skippedSkills: [] });
});

describe('POST /api/projects/:projectId/sessions/dispatch', () => {
  it('starts a session owned by the caller and returns a session ref token', async () => {
    const res = await request(mount(asUser))
      .post('/api/projects/web/sessions/dispatch')
      .send({
        prompt: 'Fix the login redirect\nDetails follow',
        agentId: 'web-dev',
        mode: 'review',
      })
      .expect(201);

    expect(res.body).toEqual({
      sessionId: 'new-sess',
      agentId: 'web-dev',
      projectId: 'web',
      name: 'Fix the login redirect',
      skippedSkills: [],
      ref: '@[Fix the login redirect](session:new-sess)',
    });
    const [proj, cfg, opts] = mocks.dispatch.mock.calls[0]!;
    expect(proj).toBe(project);
    expect(cfg).toMatchObject({
      prompt: 'Fix the login redirect\nDetails follow',
      ownerUserId: 'user-1',
      sessionAgentId: 'web-dev',
      sessionMode: 'review',
      runAsSession: true,
    });
    expect(opts).toEqual({ sessionName: 'Fix the login redirect' });
  });

  it('runs as the calling session owner on the global key (the Hub assistant path)', async () => {
    await request(mount(asGlobalKey))
      .post('/api/projects/web/sessions/dispatch')
      .set('X-Agent-Hub-Session-Id', 'hub-sess')
      .send({ prompt: 'Triage', name: 'Triage run' })
      .expect(201);
    const [, cfg, opts] = mocks.dispatch.mock.calls[0]!;
    expect(cfg.ownerUserId).toBe('owner-1');
    expect(opts).toEqual({ sessionName: 'Triage run' });
  });

  it('needs a user identity to own the session', async () => {
    const res = await request(mount(asGlobalKey))
      .post('/api/projects/web/sessions/dispatch')
      .send({ prompt: 'x' })
      .expect(401);
    expect(res.body.code).toBe('authentication_required');
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('404s unknown projects and the Hub system project', async () => {
    await request(mount(asUser))
      .post('/api/projects/nope/sessions/dispatch')
      .send({ prompt: 'x' })
      .expect(404);
    await request(mount(asUser))
      .post(`/api/projects/${HUB_PROJECT_ID}/sessions/dispatch`)
      .send({ prompt: 'x' })
      .expect(404);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('rejects an empty prompt and unknown modes', async () => {
    await request(mount(asUser))
      .post('/api/projects/web/sessions/dispatch')
      .send({ prompt: '  ' })
      .expect(400);
    await request(mount(asUser))
      .post('/api/projects/web/sessions/dispatch')
      .send({ prompt: 'x', mode: 'design' })
      .expect(400);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('maps dispatch errors to 400 / 503', async () => {
    mocks.dispatch.mockImplementationOnce(() => {
      throw new BackgroundSessionDispatchError('no_session_agent', 'Agent "docs" cannot host');
    });
    const bad = await request(mount(asUser))
      .post('/api/projects/web/sessions/dispatch')
      .send({ prompt: 'x', agentId: 'docs' })
      .expect(400);
    expect(bad.body).toEqual({ error: 'Agent "docs" cannot host', code: 'no_session_agent' });

    mocks.dispatch.mockImplementationOnce(() => {
      throw new BackgroundSessionDispatchError('no_hook', 'not ready');
    });
    await request(mount(asUser))
      .post('/api/projects/web/sessions/dispatch')
      .send({ prompt: 'x' })
      .expect(503);
  });
});

describe('sessionNameFromPrompt', () => {
  it('uses the first line and truncates long ones', () => {
    expect(sessionNameFromPrompt('  Short title\nmore')).toBe('Short title');
    const long = 'a'.repeat(80);
    const name = sessionNameFromPrompt(long);
    expect(name.length).toBeLessThanOrEqual(60);
    expect(name.endsWith('...')).toBe(true);
  });
});
