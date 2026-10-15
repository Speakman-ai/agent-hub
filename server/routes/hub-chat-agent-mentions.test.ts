/**
 * `@agent` mentions outside agent channels: a post in a channel, group or DM
 * that mentions an agent dispatches it in a session owned by the poster (one
 * per channel, agent and poster), and the reply is relayed back into the
 * channel as the agent. Dispatch and the chat handler are mocked; no CLI runs.
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
const { formatHubChatRefToken } = await import('../../shared/utils/hubChatRefTokens.js');

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

const mention = (agentId: string) => formatHubChatRefToken(agentId, 'agent', agentId)!;

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

function owner(sessionId: string): string | null {
  const row = getDb().prepare('SELECT owner_user_id FROM sessions WHERE id = ?').get(sessionId) as
    | { owner_user_id: string | null }
    | undefined;
  return row?.owner_user_id ?? null;
}

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hub-chat-mention-'));
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

function general(kind: 'channel' | 'group' = 'channel') {
  return store.createChannel({
    orgId: 'acme',
    kind,
    name: kind === 'channel' ? 'general' : '',
    createdByUserId: alice,
    memberUserIds: [bob],
  });
}

function post(userId: string, channelId: string, body: string, sessionId?: string) {
  return request(as(userId, sessionId))
    .post(`/api/chat/channels/${channelId}/messages`)
    .send({ body })
    .expect(201);
}

function agentMessages(channelId: string) {
  return store.listMessages(channelId).filter((m) => m.author_kind === 'agent');
}

describe('@agent mentions in channels', () => {
  it('dispatches the agent in a poster-owned session and relays the reply', async () => {
    const ch = general();
    await post(bob, ch.id, 'the deploy is red again');
    await post(alice, ch.id, 'saw it, looking');
    const res = await post(alice, ch.id, `${mention('web-dev')} why did the deploy fail?`);

    expect(res.body.mentionSessions).toEqual([{ agentId: 'web-dev', sessionId: 'sess-1' }]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const cfg = dispatch.mock.calls[0]![1] as {
      ownerUserId: string;
      sessionAgentId: string;
      prompt: string;
      name: string;
    };
    expect(cfg.ownerUserId).toBe(alice);
    expect(cfg.sessionAgentId).toBe('web-dev');
    expect(cfg.name).toBe('@web Dev in #general');
    expect(cfg.prompt).toContain('> **bob:** the deploy is red again');
    expect(cfg.prompt).toContain('> **alice:** saw it, looking');
    expect(cfg.prompt).toMatch(/The message that mentioned you:\n\n\*\*alice:\*\* .*why did/);
    expect(owner('sess-1')).toBe(alice);

    turnDone('sess-1', 'The migration step timed out.');
    await vi.advanceTimersByTimeAsync(20);

    const [reply] = agentMessages(ch.id);
    expect(reply).toMatchObject({ author_agent_id: 'web-dev', author_user_id: null });
    expect(reply!.body).toContain('The migration step timed out.');
    expect(reply!.body).toContain('(session:sess-1)');
    expect(JSON.parse(reply!.refs_json!)).toEqual([
      { kind: 'session', targetId: 'sess-1', projectId: 'web' },
    ]);
    // Mentions in a normal channel do not emit agent-channel header state.
    expect(broadcasts.some((b) => b.reason === 'agent_state')).toBe(false);
  });

  it('quotes at most the last 20 channel messages', async () => {
    const ch = general();
    for (let i = 1; i <= 25; i++) {
      store.appendMessage({
        channelId: ch.id,
        authorKind: 'user',
        authorUserId: bob,
        body: `line ${i}`,
      });
    }
    await post(alice, ch.id, `${mention('web-dev')} summarize`);
    const prompt = (dispatch.mock.calls[0]![1] as { prompt: string }).prompt;
    expect(prompt).not.toContain('line 5\n');
    expect(prompt).toContain('> **bob:** line 6');
    expect(prompt).toContain('> **bob:** line 25');
  });

  it('works in groups and DMs', async () => {
    const group = general('group');
    await post(alice, group.id, `${mention('web-dev')} hi`);
    expect((dispatch.mock.calls[0]![1] as { name: string }).name).toBe('@web Dev in a group chat');
    const dm = store.getOrCreateDm('acme', alice, bob).channel;
    await post(alice, dm.id, `${mention('web-dev')} hi`);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('reuses the session per (channel, agent, poster)', async () => {
    const ch = general();
    await post(alice, ch.id, `${mention('web-dev')} one`);
    turnDone('sess-1', 'first');
    await vi.advanceTimersByTimeAsync(20);

    const again = await post(alice, ch.id, `${mention('web-dev')} two`);
    expect(again.body.mentionSessions).toEqual([{ agentId: 'web-dev', sessionId: 'sess-1' }]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(handleChat).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        sessionId: 'sess-1',
        agentId: 'web-dev',
        content: expect.stringContaining('**alice:** '),
        _userMessageId: expect.any(String),
      }),
    );
    const content = (handleChat.mock.calls[0]![1] as ChatMessage).content;
    // The earlier exchange is quoted as context, the agent's reply included.
    expect(content).toContain('> **web Dev:** first');
    // Ref tokens read as plain text, so chips do not leak markup into the prompt.
    expect(content).not.toContain('(session:sess-1)');
    expect(content).toContain('**alice:** @web-dev two');
    turnDone('sess-1', 'second');
    await vi.advanceTimersByTimeAsync(20);
    expect(agentMessages(ch.id).map((m) => m.body.split('\n')[0])).toEqual(['first', 'second']);

    // Another poster gets their own session, on their own credentials.
    const bobs = await post(bob, ch.id, `${mention('web-dev')} three`);
    expect(bobs.body.mentionSessions).toEqual([{ agentId: 'web-dev', sessionId: 'sess-2' }]);
    expect(owner('sess-2')).toBe(bob);
  });

  it('starts a fresh session when the remembered one was archived', async () => {
    const ch = general();
    await post(alice, ch.id, `${mention('web-dev')} one`);
    getDb().prepare(`UPDATE sessions SET deleted_at = datetime('now') WHERE id = 'sess-1'`).run();
    const res = await post(alice, ch.id, `${mention('web-dev')} two`);
    expect(res.body.mentionSessions).toEqual([{ agentId: 'web-dev', sessionId: 'sess-2' }]);
  });

  it('refuses an agent the poster cannot use, with a notice only they see', async () => {
    const ch = general();
    const res = await post(bob, ch.id, `${mention('vault-dev')} open the vault`);
    expect(dispatch).not.toHaveBeenCalled();
    expect(res.body.mentionSessions).toEqual([]);
    expect(res.body.mentionNotices).toEqual([
      expect.objectContaining({ agentId: 'vault-dev', code: 'mention_forbidden' }),
    ]);
    const notice = broadcasts.find((b) => b.type === 'hub_chat_notice');
    expect(notice).toMatchObject({
      recipientUserIds: [bob],
      channelId: ch.id,
      messageId: res.body.message.id,
      code: 'mention_forbidden',
    });
    // Nothing stored for the notice; the mention itself is plain text.
    const stored = store.listMessages(ch.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.author_kind).toBe('user');
    expect(res.body.message.refs ?? []).toEqual([]);
  });

  it('refuses a reviewer agent and dispatches at most three agents', async () => {
    const ch = general();
    const body = ['web-reviewer', 'web-dev', 'api-dev', 'ops-dev', 'docs-dev']
      .map(mention)
      .join(' ');
    const res = await post(alice, ch.id, `${body} status?`);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(res.body.mentionSessions.map((s: { agentId: string }) => s.agentId)).toEqual([
      'web-dev',
      'api-dev',
      'ops-dev',
    ]);
    expect(res.body.mentionNotices.map((n: { code: string }) => n.code)).toEqual([
      'mention_not_eligible',
      'mention_limit',
    ]);
  });

  it('never dispatches from an agent-authored post', async () => {
    const ch = general();
    getStmts().createSession.run('s-agent', 'api-dev', 'x', 'claude-code', 'm', 0, 0, 1);
    getDb().prepare(`UPDATE sessions SET owner_user_id = ? WHERE id = 's-agent'`).run(alice);
    const res = await post(alice, ch.id, `${mention('web-dev')} over to you`, 's-agent');
    expect(res.body.message.authorKind).toBe('agent');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not dispatch when a relayed reply mentions another agent', async () => {
    const ch = general();
    await post(alice, ch.id, `${mention('web-dev')} who owns the API?`);
    turnDone('sess-1', `Ask ${mention('api-dev')} about that.`);
    await vi.advanceTimersByTimeAsync(20);
    expect(agentMessages(ch.id)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('leaves agent channels to their own agent', async () => {
    const res = await request(as(alice))
      .post('/api/chat/channels')
      .send({ kind: 'agent', projectId: 'web', agentId: 'web-dev' })
      .expect(201);
    const posted = await post(alice, res.body.channel.id, `${mention('api-dev')} ping`);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0]![1] as { sessionAgentId: string }).sessionAgentId).toBe(
      'web-dev',
    );
    expect(posted.body.mentionSessions).toEqual([]);
  });

  it('posts a notice naming the agent when the session cannot start', async () => {
    const ch = general();
    dispatch.mockImplementationOnce(() => {
      throw new Error('no credentials');
    });
    const res = await post(alice, ch.id, `${mention('web-dev')} hi`);
    expect(res.body.mentionSessions).toEqual([{ agentId: 'web-dev', sessionId: null }]);
    const notice = store.listMessages(ch.id).find((m) => m.author_kind === 'system');
    expect(notice?.body).toBe('@web Dev could not start: no credentials');
  });

  it('relays the reply of a mention turn that was in flight across a restart', async () => {
    const ch = general();
    await post(alice, ch.id, `${mention('web-dev')} go`);
    agentChannels.resetAgentChannels();
    agentChannels.initAgentChannels(relayDeps);
    agentChannels.observeBroadcastForAgentChannels({
      type: 'message',
      autoResume: true,
      message: { id: 'resume-1', session_id: 'sess-1', role: 'user', content: 'resume' },
    });
    turnDone('sess-1', 'resumed answer');
    await vi.advanceTimersByTimeAsync(50);
    const [reply] = agentMessages(ch.id);
    expect(reply).toMatchObject({ author_agent_id: 'web-dev' });
    expect(reply!.body.split('\n')[0]).toBe('resumed answer');
  });

  it('broadcasts which mentioned agents are still answering, and clears them', async () => {
    const ch = general();
    const mentionStates = () =>
      broadcasts
        .filter((b) => b.reason === 'mention_state' && b.channelId === ch.id)
        .map((b) => b.mentionPending);
    await post(alice, ch.id, `${mention('web-dev')} ${mention('api-dev')} status?`);
    expect(mentionStates().at(-1)).toEqual([
      { agentId: 'web-dev', agentName: 'web Dev', sessionId: 'sess-1' },
      { agentId: 'api-dev', agentName: 'api Dev', sessionId: 'sess-2' },
    ]);
    expect(broadcasts.find((b) => b.reason === 'mention_state')?.recipientUserIds).toEqual(
      [alice, bob].sort(),
    );
    const listed = await request(as(bob)).get('/api/chat/channels').expect(200);
    const row = listed.body.channels.find((c: { id: string }) => c.id === ch.id);
    expect(row.mentionPending.map((p: { agentId: string }) => p.agentId)).toEqual([
      'web-dev',
      'api-dev',
    ]);
    expect(row.agentState).toBeNull();

    turnDone('sess-1', 'all green');
    await vi.advanceTimersByTimeAsync(20);
    expect(mentionStates().at(-1)).toEqual([
      { agentId: 'api-dev', agentName: 'api Dev', sessionId: 'sess-2' },
    ]);

    // A turn that ends without a reply (error, cancel) is no longer pending.
    agentChannels.observeBroadcastForAgentChannels({ type: 'error', sessionId: 'sess-2' });
    await vi.advanceTimersByTimeAsync(20);
    expect(mentionStates().at(-1)).toEqual([]);
  });

  it('clears the pending agent when its session cannot start', async () => {
    const ch = general();
    dispatch.mockImplementationOnce(() => {
      throw new Error('no credentials');
    });
    await post(alice, ch.id, `${mention('web-dev')} hi`);
    const states = broadcasts.filter((b) => b.reason === 'mention_state');
    expect(states.at(-1)?.mentionPending).toEqual([]);
  });
});

describe('@ autocomplete for agents', () => {
  const agentLabels = (body: { suggestions: { kind: string; label: string }[] }) =>
    body.suggestions.filter((s) => s.kind === 'agent').map((s) => s.label);

  it('offers only agents the poster can use that answer mentions', async () => {
    const asBob = await request(as(bob)).get('/api/chat/refs/search?trigger=@&q=dev').expect(200);
    expect(agentLabels(asBob.body)).toEqual(['web Dev', 'api Dev', 'ops Dev', 'docs Dev']);
    const reviewers = await request(as(alice))
      .get('/api/chat/refs/search?trigger=@&q=reviewer')
      .expect(200);
    expect(agentLabels(reviewers.body)).toEqual([]);
  });

  it('keeps room for agents in an org with many members', async () => {
    for (let i = 0; i < 12; i++) {
      createMembership(createUser({ username: `user${i}`, passwordHash: 'x' }).id, 'acme', 'User');
    }
    const res = await request(as(alice)).get('/api/chat/refs/search?trigger=@&q=').expect(200);
    expect(res.body.suggestions).toHaveLength(8);
    expect(agentLabels(res.body)).toHaveLength(4);
  });
});
