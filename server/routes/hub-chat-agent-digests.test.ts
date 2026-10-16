/**
 * Agent digests: a scheduled digest that runs its prompt as a session of a
 * chosen project agent, with chosen skills, and relays the agent's reply into
 * the channel. Dispatch and the chat handler are mocked; no CLI runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import type { ChatMessage, Project, RouteDeps } from '../types.js';

const { initDb, getStmts, getDb } = await import('../db.js');
const { initOrgsDb, setOrgsDbPathForTests, createOrg, setActiveOrgId } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { createMembership } = await import('../memberships-store.js');
const { default: createHubChatRoutes } = await import('./hub-chat.js');
const agentChannels = await import('../hub-chat-agent-channels.js');
const store = await import('../hub-chat-store.js');

let alice = '';
let bob = '';
let projects: Project[] = [];
let broadcasts: Record<string, unknown>[] = [];
let handleChat: ReturnType<typeof vi.fn>;
let dispatch: ReturnType<typeof vi.fn>;
const activeProcesses = new Map<string, unknown>();
let relayDeps: Parameters<typeof agentChannels.initAgentChannels>[0];

function project(id: string, extra: Partial<Project> = {}): Project {
  return {
    id,
    name: id.toUpperCase(),
    cwd: '/tmp',
    agents: [
      { id: `${id}-dev`, name: `${id} Dev`, engine: 'claude-code' },
      { id: `${id}-reviewer`, name: `${id} Reviewer`, engine: 'claude-code', role: 'reviewer' },
    ],
    ...extra,
  } as Project;
}

function as(userId: string, sessionId?: string): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const areq = req as unknown as Record<string, unknown>;
    areq.authUserId = userId;
    areq.authUser = 'x';
    areq.authRole = 'User';
    areq.authOrgId = 'acme';
    if (sessionId) req.headers['x-agent-hub-session-id'] = sessionId;
    next();
  });
  app.use(
    createHubChatRoutes({
      stmts: getStmts(),
      broadcast: (d: Record<string, unknown>) => broadcasts.push(d),
      findProject: (id: string) => projects.find((p) => p.id === id) ?? null,
      getProjects: () => projects,
    } as unknown as RouteDeps),
  );
  return app;
}

function turnStart(sessionId: string, id: string) {
  agentChannels.observeBroadcastForAgentChannels({
    type: 'message',
    message: { id, session_id: sessionId, role: 'user', content: 'x' },
  });
}

function turnDone(sessionId: string, content: string) {
  agentChannels.observeBroadcastForAgentChannels({
    type: 'done',
    sessionId,
    messageId: `m-${content.length}`,
    message: { id: `m-${content.length}`, content },
  });
}

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hub-chat-agent-digest-'));
  initDb(dir);
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  initOrgsDb();
  createOrg({ id: 'acme', name: 'Acme', mode: 'remote' });
  setActiveOrgId('acme');
  alice = createUser({ username: 'alice', passwordHash: 'x' }).id;
  bob = createUser({ username: 'bob', passwordHash: 'x' }).id;
  createMembership(alice, 'acme', 'User');
  createMembership(bob, 'acme', 'User');
  projects = [
    project('web'),
    project('api'),
    project('ops'),
    project('docs'),
    project('vault', { visibility: 'private', ownerUserId: alice }),
  ];
  broadcasts = [];
  activeProcesses.clear();

  const stmts = getStmts();
  handleChat = vi.fn(async (_ws: unknown, msg: ChatMessage) => {
    turnStart(msg.sessionId, msg._userMessageId ?? 'direct');
  });
  let n = 0;
  dispatch = vi.fn(
    (
      _project: Project,
      cfg: { sessionAgentId?: string | null; ownerUserId?: string | null; name: string },
      opts: { userMessageId?: string },
    ) => {
      const sessionId = `sess-${++n}`;
      stmts.createSession.run(sessionId, cfg.sessionAgentId, cfg.name, 'claude-code', 'm', 0, 0, 1);
      getDb()
        .prepare('UPDATE sessions SET owner_user_id = ? WHERE id = ?')
        .run(cfg.ownerUserId ?? null, sessionId);
      if (opts.userMessageId) turnStart(sessionId, opts.userMessageId);
      return { sessionId, agentId: cfg.sessionAgentId, skippedSkills: [] };
    },
  );
  relayDeps = {
    stmts,
    broadcast: (d) => broadcasts.push(d),
    findProject: (id) => projects.find((p) => p.id === id) ?? null,
    handleChat: handleChat as unknown as (ws: unknown, msg: ChatMessage) => Promise<void>,
    activeProcesses,
    dispatch: dispatch as never,
    settleMs: 10,
    restoreGraceMs: 100,
  };
  agentChannels.initAgentChannels(relayDeps);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  agentChannels.resetAgentChannels();
});

const PROMPT =
  'Go through the server logs in the last 24 hours and show me any that are of concern.';

function channel() {
  return store.createChannel({
    orgId: 'acme',
    kind: 'channel',
    name: 'ops',
    createdByUserId: alice,
    memberUserIds: [bob],
  });
}

const base = {
  name: 'Log Summary',
  enabled: true,
  cron: '0 9 * * 1-5',
  timeZone: 'America/Chicago',
  scope: 'agent',
  projectIds: ['web'],
  agentId: 'web-dev',
  skills: ['support-logs'],
  prompt: PROMPT,
};

describe('agent digests', () => {
  it('saves project, agent, skills and prompt', async () => {
    const ch = channel();
    const res = await request(as(alice))
      .post(`/api/chat/channels/${ch.id}/digests`)
      .send(base)
      .expect(201);
    expect(res.body.digest).toMatchObject({
      scope: 'agent',
      projectIds: ['web'],
      agentId: 'web-dev',
      skills: ['support-logs'],
      prompt: PROMPT,
    });
  });

  it('requires an eligible agent from the project and a prompt', async () => {
    const ch = channel();
    const post = (body: Record<string, unknown>) =>
      request(as(alice)).post(`/api/chat/channels/${ch.id}/digests`).send(body);
    expect((await post({ ...base, agentId: null }).expect(400)).body.code).toBe('agent_required');
    expect((await post({ ...base, agentId: 'api-dev' }).expect(400)).body.code).toBe(
      'agent_required',
    );
    expect((await post({ ...base, agentId: 'web-reviewer' }).expect(400)).body.code).toBe(
      'agent_required',
    );
    expect((await post({ ...base, prompt: '  ' }).expect(400)).body.code).toBe('prompt_required');
    expect((await post({ ...base, projectIds: ['web', 'api'] }).expect(400)).body.code).toBe(
      'one_project_required',
    );
  });

  it('Run now dispatches the agent with the prompt and skills and posts its reply', async () => {
    const ch = channel();
    const created = await request(as(alice))
      .post(`/api/chat/channels/${ch.id}/digests`)
      .send(base)
      .expect(201);
    const digestId = created.body.digest.id as string;

    const run = await request(as(bob))
      .post(`/api/chat/channels/${ch.id}/digests/${digestId}/run`)
      .expect(200);
    expect(run.body.result.error).toBeUndefined();
    expect(run.body.result).toMatchObject({ status: 'started', sessionId: 'sess-1' });
    expect(run.body.digest.lastStatus).toBe('started');

    expect(dispatch).toHaveBeenCalledTimes(1);
    const cfg = dispatch.mock.calls[0]![1] as {
      ownerUserId: string;
      sessionAgentId: string;
      skills: string[];
      prompt: string;
      name: string;
    };
    // The digest owner (last editor) runs it, not whoever pressed Run now.
    expect(cfg.ownerUserId).toBe(alice);
    expect(cfg.sessionAgentId).toBe('web-dev');
    expect(cfg.skills).toEqual(['support-logs']);
    expect(cfg.name).toBe('Digest: Log Summary');
    expect(cfg.prompt.startsWith(PROMPT)).toBe(true);
    // No collected project activity: the prompt is the task.
    expect(cfg.prompt).not.toContain('Facts');

    turnDone('sess-1', 'Two 500s from /api/orders at 03:12; nothing else.');
    await vi.advanceTimersByTimeAsync(20);
    const replies = store.listMessages(ch.id).filter((m) => m.author_kind === 'agent');
    expect(replies).toHaveLength(1);
    expect(replies[0]!.author_agent_id).toBe('web-dev');
    expect(replies[0]!.body).toContain('Two 500s from /api/orders');
  });

  it('posts a notice when the first turn fails to start', async () => {
    const ch = channel();
    const created = await request(as(alice))
      .post(`/api/chat/channels/${ch.id}/digests`)
      .send(base)
      .expect(201);
    dispatch.mockImplementationOnce(
      (
        _p: Project,
        cfg: { sessionAgentId?: string | null; name: string },
        opts: { onKickoffError?: (m: string) => void },
      ) => {
        getStmts().createSession.run(
          'sess-x',
          cfg.sessionAgentId,
          cfg.name,
          'claude-code',
          'm',
          0,
          0,
          1,
        );
        opts.onKickoffError?.('engine not signed in');
        return { sessionId: 'sess-x', agentId: cfg.sessionAgentId, skippedSkills: [] };
      },
    );
    await request(as(alice))
      .post(`/api/chat/channels/${ch.id}/digests/${created.body.digest.id}/run`)
      .expect(200);
    const notices = store.listMessages(ch.id).filter((m) => m.author_kind === 'system');
    expect(notices.map((m) => m.body)).toContainEqual(
      expect.stringContaining('engine not signed in'),
    );
  });
});
