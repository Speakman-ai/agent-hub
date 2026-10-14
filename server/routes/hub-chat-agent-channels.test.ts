/**
 * Agent channels: a channel bound to a project agent. A member's post runs in
 * the channel's linked session (dispatched once, then continued), and the
 * agent's reply is posted back as an agent message with a session chip once
 * the session settles.
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
let carol = '';
let projects: Project[] = [];
let broadcasts: Record<string, unknown>[] = [];
let handleChat: ReturnType<typeof vi.fn>;
let dispatch: ReturnType<typeof vi.fn>;
const activeProcesses = new Map<string, unknown>();
let holdTurns = false;
let relayDeps: Parameters<typeof agentChannels.initAgentChannels>[0];
let held: ChatMessage[] = [];

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

function as(userId: string): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const areq = req as unknown as Record<string, unknown>;
    areq.authUserId = userId;
    areq.authUser = 'x';
    areq.authRole = 'User';
    areq.authOrgId = 'acme';
    next();
  });
  app.use(
    createHubChatRoutes({
      stmts: {},
      broadcast: (d: Record<string, unknown>) => broadcasts.push(d),
      findProject: (id: string) => projects.find((p) => p.id === id) ?? null,
      getProjects: () => projects,
    } as unknown as RouteDeps),
  );
  return app;
}

/** Emulates the chat handler's turn-start broadcast for user message `id`. */
function turnStart(sessionId: string, id: string) {
  agentChannels.observeBroadcastForAgentChannels({
    type: 'message',
    message: { id, session_id: sessionId, role: 'user', content: 'x' },
  });
}

/** Emulates the chat handler's turn-end broadcast. */
function turnDone(sessionId: string, content: string) {
  agentChannels.observeBroadcastForAgentChannels({
    type: 'done',
    sessionId,
    messageId: `m-${content.length}`,
    message: { id: `m-${content.length}`, content },
  });
}

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hub-chat-agent-'));
  initDb(dir);
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  initOrgsDb();
  createOrg({ id: 'acme', name: 'Acme', mode: 'remote' });
  setActiveOrgId('acme');
  alice = createUser({ username: 'alice', passwordHash: 'x' }).id;
  bob = createUser({ username: 'bob', passwordHash: 'x' }).id;
  carol = createUser({ username: 'carol', passwordHash: 'x' }).id;
  createMembership(alice, 'acme', 'User');
  createMembership(bob, 'acme', 'User');
  createMembership(carol, 'acme', 'User');
  projects = [project('web'), project('vault', { visibility: 'private', ownerUserId: alice })];
  broadcasts = [];
  activeProcesses.clear();

  const stmts = getStmts();
  // Starts each turn at once unless the test holds them (to queue posts).
  handleChat = vi.fn(async (_ws: unknown, msg: ChatMessage) => {
    if (holdTurns) held.push(msg);
    else turnStart(msg.sessionId, msg._userMessageId ?? 'direct');
  });
  let n = 0;
  dispatch = vi.fn(
    (
      _project: Project,
      cfg: { sessionAgentId?: string | null },
      opts: { userMessageId?: string },
    ) => {
      const sessionId = `sess-${++n}`;
      stmts.createSession.run(
        sessionId,
        cfg.sessionAgentId,
        '#web Dev',
        'claude-code',
        'm',
        0,
        0,
        1,
      );
      if (opts.userMessageId) turnStart(sessionId, opts.userMessageId);
      return { sessionId, agentId: cfg.sessionAgentId, skippedSkills: [] };
    },
  );
  holdTurns = false;
  held = [];
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

async function makeAgentChannel(owner: string, extra: Record<string, unknown> = {}) {
  const res = await request(as(owner))
    .post('/api/chat/channels')
    .send({ kind: 'agent', projectId: 'web', agentId: 'web-dev', ...extra })
    .expect(201);
  return res.body.channel as { id: string; name: string; agentState: unknown };
}

describe('creating an agent channel', () => {
  it('binds the project agent and defaults the name to the agent', async () => {
    const ch = await makeAgentChannel(alice);
    expect(ch).toMatchObject({
      kind: 'agent',
      name: 'web Dev',
      projectId: 'web',
      agentId: 'web-dev',
      agentState: { sessionId: null, sessionName: null, running: false },
    });
  });

  it('requires a project and agent', async () => {
    await request(as(alice))
      .post('/api/chat/channels')
      .send({ kind: 'agent', projectId: 'web' })
      .expect(400);
  });

  it('rejects an agent outside the project, a hidden project, and a reviewer', async () => {
    const send = (user: string, body: Record<string, unknown>) =>
      request(as(user))
        .post('/api/chat/channels')
        .send({ kind: 'agent', ...body });
    expect((await send(alice, { projectId: 'web', agentId: 'vault-dev' })).status).toBe(404);
    expect((await send(bob, { projectId: 'vault', agentId: 'vault-dev' })).status).toBe(404);
    const reviewer = await send(alice, { projectId: 'web', agentId: 'web-reviewer' });
    expect(reviewer.status).toBe(400);
    expect(reviewer.body.code).toBe('agent_not_eligible');
  });
});

describe('posting in an agent channel', () => {
  it('dispatches a session on the first post and posts the reply back', async () => {
    const ch = await makeAgentChannel(alice, { memberUserIds: [bob] });
    const res = await request(as(alice))
      .post(`/api/chat/channels/${ch.id}/messages`)
      .send({ body: 'what changed today?' })
      .expect(201);
    expect(res.body.agentSessionId).toBe('sess-1');
    expect(dispatch).toHaveBeenCalledTimes(1);
    const cfg = dispatch.mock.calls[0]![1] as { ownerUserId: string; prompt: string };
    expect(cfg.ownerUserId).toBe(alice);
    expect(cfg.prompt).toContain('**alice:** what changed today?');
    expect(store.getChannel(ch.id)?.session_id).toBe('sess-1');

    // Running while the turn is out.
    const mid = await request(as(alice)).get(`/api/chat/channels/${ch.id}`).expect(200);
    expect(mid.body.channel.agentState).toMatchObject({ sessionId: 'sess-1', running: true });

    turnDone('sess-1', 'Two PRs merged.');
    await vi.advanceTimersByTimeAsync(20);

    const msgs = await request(as(bob)).get(`/api/chat/channels/${ch.id}/messages`).expect(200);
    const reply = msgs.body.messages.at(-1);
    expect(reply).toMatchObject({
      authorKind: 'agent',
      authorAgentId: 'web-dev',
      authorUserId: null,
      payload: { sessionId: 'sess-1' },
    });
    expect(reply.body).toContain('Two PRs merged.');
    expect(reply.body).toContain('(session:sess-1)');
    expect(reply.refs).toEqual([{ kind: 'session', targetId: 'sess-1', projectId: 'web' }]);
    // Bob hears it live and the header flips back to idle.
    expect(
      broadcasts.some(
        (b) =>
          b.type === 'hub_chat_message' &&
          (b.recipientUserIds as string[]).includes(bob) &&
          (b.message as { authorKind: string }).authorKind === 'agent',
      ),
    ).toBe(true);
    const after = await request(as(alice)).get(`/api/chat/channels/${ch.id}`).expect(200);
    expect(after.body.channel.agentState.running).toBe(false);
  });

  it('reuses the linked session for later posts', async () => {
    const ch = await makeAgentChannel(alice, { memberUserIds: [bob] });
    await request(as(alice)).post(`/api/chat/channels/${ch.id}/messages`).send({ body: 'one' });
    turnDone('sess-1', 'first');
    await vi.advanceTimersByTimeAsync(20);

    const res = await request(as(bob))
      .post(`/api/chat/channels/${ch.id}/messages`)
      .send({ body: 'two' })
      .expect(201);
    expect(res.body.agentSessionId).toBe('sess-1');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(handleChat).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        type: 'chat',
        agentId: 'web-dev',
        sessionId: 'sess-1',
        content: '**bob:** two',
        _userMessageId: expect.any(String),
      }),
    );
  });

  it('waits for the session to go idle and posts only the final reply', async () => {
    const ch = await makeAgentChannel(alice);
    await request(as(alice)).post(`/api/chat/channels/${ch.id}/messages`).send({ body: 'go' });
    activeProcesses.set('sess-1', {});
    turnDone('sess-1', 'step one');
    await vi.advanceTimersByTimeAsync(50);
    turnDone('sess-1', 'final answer');
    activeProcesses.delete('sess-1');
    await vi.advanceTimersByTimeAsync(50);
    const agentMsgs = store.listMessages(ch.id).filter((m) => m.author_kind === 'agent');
    expect(agentMsgs).toHaveLength(1);
    expect(agentMsgs[0]!.body).toContain('final answer');
  });

  it('does not relay turns the channel did not start', async () => {
    const ch = await makeAgentChannel(alice);
    await request(as(alice)).post(`/api/chat/channels/${ch.id}/messages`).send({ body: 'go' });
    turnDone('sess-1', 'reply');
    await vi.advanceTimersByTimeAsync(20);
    turnStart('sess-1', 'direct-1');
    turnDone('sess-1', 'someone chatted in the session directly');
    await vi.advanceTimersByTimeAsync(20);
    expect(store.listMessages(ch.id).filter((m) => m.author_kind === 'agent')).toHaveLength(1);
  });

  it('keeps a direct turn that starts before the channel reply settles out of the channel', async () => {
    const ch = await makeAgentChannel(alice, { memberUserIds: [bob] });
    await request(as(alice)).post(`/api/chat/channels/${ch.id}/messages`).send({ body: 'go' });
    turnDone('sess-1', 'channel answer');
    // The owner chats in the session directly before the settle delay ends.
    turnStart('sess-1', 'direct-1');
    activeProcesses.set('sess-1', {});
    await vi.advanceTimersByTimeAsync(50);
    turnDone('sess-1', 'private direct answer');
    activeProcesses.delete('sess-1');
    await vi.advanceTimersByTimeAsync(50);

    const agentMsgs = store.listMessages(ch.id).filter((m) => m.author_kind === 'agent');
    expect(agentMsgs).toHaveLength(1);
    expect(agentMsgs[0]!.body).toContain('channel answer');
    expect(JSON.stringify(broadcasts)).not.toContain('private direct answer');
    const state = await request(as(alice)).get(`/api/chat/channels/${ch.id}`).expect(200);
    expect(state.body.channel.agentState.running).toBe(false);
  });

  it('ignores a direct turn already running when a channel post is queued behind it', async () => {
    const ch = await makeAgentChannel(alice);
    await request(as(alice)).post(`/api/chat/channels/${ch.id}/messages`).send({ body: 'one' });
    turnDone('sess-1', 'first');
    await vi.advanceTimersByTimeAsync(20);

    turnStart('sess-1', 'direct-1');
    activeProcesses.set('sess-1', {});
    holdTurns = true;
    await request(as(alice)).post(`/api/chat/channels/${ch.id}/messages`).send({ body: 'two' });
    turnDone('sess-1', 'direct reply');
    await vi.advanceTimersByTimeAsync(50);
    // The queued channel post now runs.
    agentChannels.observeBroadcastForAgentChannels({
      type: 'queue_item_processing',
      sessionId: 'sess-1',
      messageId: held[0]!._userMessageId,
    });
    turnDone('sess-1', 'second');
    activeProcesses.delete('sess-1');
    await vi.advanceTimersByTimeAsync(50);

    const bodies = store
      .listMessages(ch.id)
      .filter((m) => m.author_kind === 'agent')
      .map((m) => m.body.split('\n')[0]);
    expect(bodies).toEqual(['first', 'second']);
  });

  it('posts a reply for each queued channel post', async () => {
    const ch = await makeAgentChannel(alice);
    await request(as(alice)).post(`/api/chat/channels/${ch.id}/messages`).send({ body: 'one' });
    activeProcesses.set('sess-1', {});
    holdTurns = true;
    await request(as(alice)).post(`/api/chat/channels/${ch.id}/messages`).send({ body: 'two' });
    turnDone('sess-1', 'answer one');
    await vi.advanceTimersByTimeAsync(50);
    agentChannels.observeBroadcastForAgentChannels({
      type: 'queue_item_processing',
      sessionId: 'sess-1',
      messageId: held[0]!._userMessageId,
    });
    turnDone('sess-1', 'answer two');
    activeProcesses.delete('sess-1');
    await vi.advanceTimersByTimeAsync(50);
    const bodies = store
      .listMessages(ch.id)
      .filter((m) => m.author_kind === 'agent')
      .map((m) => m.body.split('\n')[0]);
    expect(bodies).toEqual(['answer one', 'answer two']);
  });

  it('starts a new session when the linked one was archived', async () => {
    const ch = await makeAgentChannel(alice);
    await request(as(alice)).post(`/api/chat/channels/${ch.id}/messages`).send({ body: 'a' });
    getStmts().softDeleteSession.run('sess-1');
    const res = await request(as(alice))
      .post(`/api/chat/channels/${ch.id}/messages`)
      .send({ body: 'b' })
      .expect(201);
    expect(res.body.agentSessionId).toBe('sess-2');
    expect(store.getChannel(ch.id)?.session_id).toBe('sess-2');
  });

  it('refuses a member who cannot see the project', async () => {
    const res = await request(as(alice))
      .post('/api/chat/channels')
      .send({ kind: 'agent', projectId: 'vault', agentId: 'vault-dev', memberUserIds: [carol] })
      .expect(201);
    const denied = await request(as(carol))
      .post(`/api/chat/channels/${res.body.channel.id}/messages`)
      .send({ body: 'hi' });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('project_access_required');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('posts a notice when the session cannot start', async () => {
    dispatch.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const ch = await makeAgentChannel(alice);
    const res = await request(as(alice))
      .post(`/api/chat/channels/${ch.id}/messages`)
      .send({ body: 'hi' })
      .expect(201);
    expect(res.body.agentSessionId).toBeNull();
    const last = store.listMessages(ch.id).at(-1)!;
    expect(last.author_kind).toBe('system');
    expect(last.body).toContain('boom');
  });
});

describe('agent channel turns across a server restart', () => {
  /** Drops everything in memory and boots the relay again on the same db. */
  function restart() {
    agentChannels.resetAgentChannels();
    agentChannels.initAgentChannels(relayDeps);
  }

  function agentBodies(channelId: string) {
    return store
      .listMessages(channelId)
      .filter((m) => m.author_kind === 'agent')
      .map((m) => m.body.split('\n')[0]);
  }

  it('replies to a post that was queued when the server restarted', async () => {
    const ch = await makeAgentChannel(alice);
    await request(as(alice)).post(`/api/chat/channels/${ch.id}/messages`).send({ body: 'one' });
    activeProcesses.set('sess-1', {});
    holdTurns = true;
    await request(as(alice)).post(`/api/chat/channels/${ch.id}/messages`).send({ body: 'two' });
    const queuedId = held[0]!._userMessageId!;
    // chat.ts queues the busy turn under the caller's id.
    getStmts().enqueueMessage.run(queuedId, 'sess-1', 'web-dev', 'two', null, 0, 0);

    restart();
    activeProcesses.clear();
    // Boot drain promotes the queued post.
    getStmts().dequeueMessage.run(queuedId);
    agentChannels.observeBroadcastForAgentChannels({
      type: 'queue_item_processing',
      sessionId: 'sess-1',
      messageId: queuedId,
    });
    turnDone('sess-1', 'answer two');
    await vi.advanceTimersByTimeAsync(200);

    expect(agentBodies(ch.id)).toEqual(['answer two']);
    const state = await request(as(alice)).get(`/api/chat/channels/${ch.id}`).expect(200);
    expect(state.body.channel.agentState.running).toBe(false);
  });

  it('replies to a turn that was in flight, after the crash-resume', async () => {
    const ch = await makeAgentChannel(alice);
    await request(as(alice)).post(`/api/chat/channels/${ch.id}/messages`).send({ body: 'go' });
    restart();
    // The boot crash-resume re-drives the interrupted turn under a new message.
    agentChannels.observeBroadcastForAgentChannels({
      type: 'message',
      autoResume: true,
      message: { id: 'resume-1', session_id: 'sess-1', role: 'user', content: 'resume' },
    });
    turnDone('sess-1', 'resumed answer');
    await vi.advanceTimersByTimeAsync(50);
    expect(agentBodies(ch.id)).toEqual(['resumed answer']);
  });

  it('waits out the resume grace before giving up on an in-flight turn', async () => {
    const ch = await makeAgentChannel(alice);
    await request(as(alice)).post(`/api/chat/channels/${ch.id}/messages`).send({ body: 'go' });
    restart();
    await vi.advanceTimersByTimeAsync(50);
    let state = await request(as(alice)).get(`/api/chat/channels/${ch.id}`).expect(200);
    expect(state.body.channel.agentState.running).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    state = await request(as(alice)).get(`/api/chat/channels/${ch.id}`).expect(200);
    expect(state.body.channel.agentState.running).toBe(false);
  });

  it('drops a post that never reached the session before the restart', async () => {
    const ch = await makeAgentChannel(alice);
    await request(as(alice)).post(`/api/chat/channels/${ch.id}/messages`).send({ body: 'one' });
    turnDone('sess-1', 'first');
    await vi.advanceTimersByTimeAsync(20);
    holdTurns = true;
    await request(as(alice)).post(`/api/chat/channels/${ch.id}/messages`).send({ body: 'two' });
    restart();
    const state = await request(as(alice)).get(`/api/chat/channels/${ch.id}`).expect(200);
    expect(state.body.channel.agentState.running).toBe(false);
    const last = store.listMessages(ch.id).at(-1)!;
    expect(last.author_kind).toBe('system');
    expect(last.body).toContain('did not reach the agent');
  });
});

describe('agent channel writes are atomic', () => {
  /** Makes the next agent-authored insert into the channel fail. */
  function failAgentAppends() {
    getDb().exec(`
      CREATE TEMP TRIGGER fail_agent_reply BEFORE INSERT ON hub_chat_messages
      WHEN NEW.author_kind = 'agent'
      BEGIN SELECT RAISE(ABORT, 'injected append failure'); END;
    `);
  }
  function healAppends() {
    getDb().exec('DROP TRIGGER IF EXISTS fail_agent_reply');
  }
  afterEach(() => {
    healAppends();
    vi.restoreAllMocks();
  });

  function turnRows() {
    return getDb().prepare('SELECT * FROM hub_chat_agent_turns').all() as Array<{
      turn_id: string;
      reply_content: string | null;
    }>;
  }

  it('keeps the turn and its reply when posting the reply fails, and posts it on retry', async () => {
    const ch = await makeAgentChannel(alice);
    await request(as(alice)).post(`/api/chat/channels/${ch.id}/messages`).send({ body: 'go' });
    turnDone('sess-1', 'the answer');
    failAgentAppends();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(20);

    expect(store.listMessages(ch.id).filter((m) => m.author_kind === 'agent')).toHaveLength(0);
    expect(turnRows()).toEqual([expect.objectContaining({ reply_content: 'the answer' })]);
    expect(
      broadcasts.some(
        (b) => b.type === 'hub_chat_message' && JSON.stringify(b).includes('the answer'),
      ),
    ).toBe(false);

    healAppends();
    await vi.advanceTimersByTimeAsync(50);
    const replies = store.listMessages(ch.id).filter((m) => m.author_kind === 'agent');
    expect(replies).toHaveLength(1);
    expect(replies[0]!.body).toContain('the answer');
    expect(turnRows()).toEqual([]);
  });

  it('keeps the reply recoverable across a restart after a failed post', async () => {
    const ch = await makeAgentChannel(alice);
    await request(as(alice)).post(`/api/chat/channels/${ch.id}/messages`).send({ body: 'go' });
    turnDone('sess-1', 'survives');
    failAgentAppends();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(20);
    healAppends();
    agentChannels.resetAgentChannels();
    agentChannels.initAgentChannels(relayDeps);
    await vi.advanceTimersByTimeAsync(200);
    const replies = store.listMessages(ch.id).filter((m) => m.author_kind === 'agent');
    expect(replies.map((m) => m.body.split('\n')[0])).toEqual(['survives']);
  });

  it('stores a post and its agent turn together', async () => {
    const ch = await makeAgentChannel(alice);
    getDb().exec(`
      CREATE TEMP TRIGGER fail_turn BEFORE INSERT ON hub_chat_agent_turns
      BEGIN SELECT RAISE(ABORT, 'injected turn failure'); END;
    `);
    try {
      const res = await request(as(alice))
        .post(`/api/chat/channels/${ch.id}/messages`)
        .send({ body: 'go' });
      expect(res.status).toBe(500);
      expect(store.listMessages(ch.id)).toHaveLength(0);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      getDb().exec('DROP TRIGGER IF EXISTS fail_turn');
    }
  });
});
