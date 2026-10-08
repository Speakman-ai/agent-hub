import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request } from 'express';
import request from 'supertest';
import type { RouteDeps } from '../types.js';

const MESSAGES_READONLY = 'https://www.googleapis.com/auth/chat.messages.readonly';
const MESSAGES_CREATE = 'https://www.googleapis.com/auth/chat.messages.create';
const SPACES_READONLY = 'https://www.googleapis.com/auth/chat.spaces.readonly';

const googleMock = vi.hoisted(() => {
  const spaces = { list: vi.fn(), get: vi.fn() };
  const messages = { list: vi.fn(), create: vi.fn(), get: vi.fn() };
  return {
    spaces,
    messages,
    chat: vi.fn(() => ({ spaces: { ...spaces, messages, members: { list: vi.fn() } } })),
    OAuth2: vi.fn(function OAuth2() {
      return { setCredentials: vi.fn() };
    }),
  };
});

const connectionStoreMock = vi.hoisted(() => ({
  getActiveAccessToken: vi.fn(),
  getGoogleConnectionStatus: vi.fn(),
  getGoogleConnection: vi.fn(),
}));

vi.mock('googleapis', () => ({
  google: { auth: { OAuth2: googleMock.OAuth2 }, chat: googleMock.chat },
}));
vi.mock('../google-connections-store.js', () => connectionStoreMock);
// These tests cover what happens once a session's reply actually posts, so the
// owner has auto-send on. The approval path is covered in
// google-chat-drafts.test.ts.
vi.mock('../google-chat-drafts-store.js', () => ({
  getChatSettings: () => ({ autoSendAgentReplies: true }),
  OPEN_DRAFT_STATUSES: ['pending', 'sending', 'unconfirmed'],
}));

const { getDb } = await import('../db.js');
const { default: createGoogleChatRoutes, clearChatSpaceAccessCache } =
  await import('./google-chat.js');

type AuthFields = { authUserId?: string; authSpawnSessionId?: string };

function makeApp(auth: AuthFields = { authUserId: 'user-1' }): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req as Request & AuthFields, auth);
    next();
  });
  app.use(
    createGoogleChatRoutes({
      config: { googleOAuth: { clientId: 'cid', clientSecret: 'secret' } },
    } as unknown as RouteDeps),
  );
  return app;
}

function addSession(id: string, name = `Session ${id}`) {
  getDb()
    .prepare('INSERT INTO sessions (id, agent_id, name) VALUES (?, ?, ?)')
    .run(id, 'agent-a', name);
}

const MSG = 'spaces/AAA/messages/M1.M1';
const THREAD = 'spaces/AAA/threads/T1';

describe('Google Chat message links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const db = getDb();
    db.prepare('DELETE FROM google_chat_message_links').run();
    db.prepare('DELETE FROM google_chat_session_posts').run();
    db.prepare("DELETE FROM sessions WHERE id LIKE 'gcl-%'").run();
    connectionStoreMock.getGoogleConnectionStatus.mockReturnValue({
      connected: true,
      grantedScopes: [SPACES_READONLY, MESSAGES_READONLY, MESSAGES_CREATE],
    });
    connectionStoreMock.getActiveAccessToken.mockResolvedValue('tok');
    clearChatSpaceAccessCache();
    // Default: the caller can read every space and message.
    googleMock.messages.list.mockResolvedValue({ data: { messages: [] } });
    googleMock.messages.get.mockImplementation(async ({ name }: { name: string }) => ({
      data: { name, thread: { name: THREAD } },
    }));
  });

  it('links a message to a session and lists it for the space', async () => {
    addSession('gcl-1', 'Reset staging DB');
    const created = await request(makeApp())
      .post('/api/google/chat/spaces/AAA/message-links')
      .send({ messageName: MSG, threadName: THREAD, sessionId: 'gcl-1' });
    expect(created.status).toBe(201);
    expect(created.body.existing).toEqual([]);
    expect(created.body.link).toMatchObject({
      messageName: MSG,
      spaceName: 'spaces/AAA',
      threadName: THREAD,
      sessionId: 'gcl-1',
      sessionName: 'Reset staging DB',
      agentId: 'agent-a',
      userId: 'user-1',
      repliedAt: null,
    });
    expect(created.body.link.createdAt).toMatch(/Z$/);

    const listed = await request(makeApp()).get('/api/google/chat/spaces/AAA/message-links');
    expect(listed.status).toBe(200);
    expect(listed.body.links.map((l: { sessionId: string }) => l.sessionId)).toEqual(['gcl-1']);
    const other = await request(makeApp()).get('/api/google/chat/spaces/BBB/message-links');
    expect(other.body.links).toEqual([]);
  });

  it('reports links to other sessions when the message is sent again', async () => {
    addSession('gcl-1');
    addSession('gcl-2');
    await request(makeApp())
      .post('/api/google/chat/spaces/AAA/message-links')
      .send({ messageName: MSG, sessionId: 'gcl-1' });
    const second = await request(makeApp({ authUserId: 'user-2' }))
      .post('/api/google/chat/spaces/AAA/message-links')
      .send({ messageName: MSG, sessionId: 'gcl-2' });
    expect(second.status).toBe(201);
    expect(second.body.existing.map((l: { sessionId: string }) => l.sessionId)).toEqual(['gcl-1']);

    // Same pair again is idempotent.
    const again = await request(makeApp())
      .post('/api/google/chat/spaces/AAA/message-links')
      .send({ messageName: MSG, sessionId: 'gcl-1' });
    expect(again.status).toBe(200);
    expect(again.body.link.sessionId).toBe('gcl-1');
    const listed = await request(makeApp()).get('/api/google/chat/spaces/AAA/message-links');
    expect(listed.body.links).toHaveLength(2);
  });

  it('rejects a message from another space, an unknown session, and a missing read scope', async () => {
    addSession('gcl-1');
    const wrongSpace = await request(makeApp())
      .post('/api/google/chat/spaces/BBB/message-links')
      .send({ messageName: MSG, sessionId: 'gcl-1' });
    expect(wrongSpace.status).toBe(400);

    const unknown = await request(makeApp())
      .post('/api/google/chat/spaces/AAA/message-links')
      .send({ messageName: MSG, sessionId: 'gcl-missing' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('session_not_found');

    connectionStoreMock.getGoogleConnectionStatus.mockReturnValue({
      connected: true,
      grantedScopes: [SPACES_READONLY],
    });
    const noScope = await request(makeApp()).get('/api/google/chat/spaces/AAA/message-links');
    expect(noScope.status).toBe(403);
  });

  it('marks the link replied when its session posts in the linked thread', async () => {
    addSession('gcl-1');
    addSession('gcl-2');
    await request(makeApp())
      .post('/api/google/chat/spaces/AAA/message-links')
      .send({ messageName: MSG, threadName: THREAD, sessionId: 'gcl-1' });
    googleMock.spaces.get.mockResolvedValue({
      data: { spaceType: 'SPACE', spaceThreadingState: 'THREADED_MESSAGES' },
    });

    // A different session posting in the thread does not count.
    googleMock.messages.create.mockResolvedValue({
      data: {
        name: 'spaces/AAA/messages/X1',
        thread: { name: THREAD },
        space: { name: 'spaces/AAA' },
      },
    });
    const other = await request(makeApp({ authUserId: 'user-1', authSpawnSessionId: 'gcl-2' }))
      .post('/api/google/chat/spaces/AAA/messages')
      .send({ text: 'hi', threadName: THREAD });
    expect(other.status).toBe(201);
    // Neither does the linked session posting in another thread.
    googleMock.messages.create.mockResolvedValue({
      data: {
        name: 'spaces/AAA/messages/X2',
        thread: { name: 'spaces/AAA/threads/OTHER' },
        space: { name: 'spaces/AAA' },
      },
    });
    const elsewhere = await request(makeApp({ authUserId: 'user-1', authSpawnSessionId: 'gcl-1' }))
      .post('/api/google/chat/spaces/AAA/messages')
      .send({ text: 'elsewhere' });
    expect(elsewhere.status).toBe(201);
    let links = (await request(makeApp()).get('/api/google/chat/spaces/AAA/message-links')).body
      .links;
    expect(links[0].repliedAt).toBeNull();

    googleMock.messages.create.mockResolvedValue({
      data: {
        name: 'spaces/AAA/messages/R1',
        thread: { name: THREAD },
        space: { name: 'spaces/AAA' },
      },
    });
    const reply = await request(makeApp())
      .post('/api/google/chat/spaces/AAA/messages')
      .set('X-Agent-Hub-Session-Id', 'gcl-1')
      .send({ text: 'Done, staging is reset.', threadName: THREAD });
    expect(reply.status).toBe(201);
    links = (await request(makeApp()).get('/api/google/chat/spaces/AAA/message-links')).body.links;
    expect(links[0].repliedAt).toMatch(/Z$/);
    expect(links[0].replyMessageName).toBe('spaces/AAA/messages/R1');
  });

  it('marks a thread-less link replied by any post from its session into the space', async () => {
    addSession('gcl-1');
    await request(makeApp())
      .post('/api/google/chat/spaces/AAA/message-links')
      .send({ messageName: MSG, sessionId: 'gcl-1' });
    googleMock.messages.create.mockResolvedValue({
      data: { name: 'spaces/AAA/messages/R9', thread: { name: 'spaces/AAA/threads/NEW' } },
    });
    const sent = await request(makeApp({ authUserId: 'user-1', authSpawnSessionId: 'gcl-1' }))
      .post('/api/google/chat/spaces/AAA/messages')
      .send({ text: 'On it' });
    expect(sent.status).toBe(201);
    const links = (await request(makeApp()).get('/api/google/chat/spaces/AAA/message-links')).body
      .links;
    expect(links[0].replyMessageName).toBe('spaces/AAA/messages/R9');
  });

  it('keeps a human send from the UI from marking links replied', async () => {
    addSession('gcl-1');
    await request(makeApp())
      .post('/api/google/chat/spaces/AAA/message-links')
      .send({ messageName: MSG, sessionId: 'gcl-1' });
    googleMock.messages.create.mockResolvedValue({
      data: { name: 'spaces/AAA/messages/H1', thread: { name: THREAD } },
    });
    await request(makeApp()).post('/api/google/chat/spaces/AAA/messages').send({ text: 'hey' });
    const links = (await request(makeApp()).get('/api/google/chat/spaces/AAA/message-links')).body
      .links;
    expect(links[0].repliedAt).toBeNull();
  });

  it('does not disclose links in a space the caller cannot read', async () => {
    addSession('gcl-1', 'Private dispatch');
    await request(makeApp())
      .post('/api/google/chat/spaces/AAA/message-links')
      .send({ messageName: MSG, sessionId: 'gcl-1' });

    googleMock.messages.list.mockRejectedValue({
      response: {
        status: 403,
        data: { error: { message: 'The caller does not have permission' } },
      },
    });
    const outsider = await request(makeApp({ authUserId: 'user-2' })).get(
      '/api/google/chat/spaces/AAA/message-links',
    );
    expect(outsider.status).toBe(403);
    expect(outsider.body.links).toBeUndefined();
    expect(JSON.stringify(outsider.body)).not.toContain('gcl-1');
    expect(googleMock.messages.list).toHaveBeenCalledWith({ parent: 'spaces/AAA', pageSize: 1 });

    googleMock.messages.list.mockRejectedValue({ response: { status: 404 } });
    const missing = await request(makeApp({ authUserId: 'user-3' })).get(
      '/api/google/chat/spaces/AAA/message-links',
    );
    expect(missing.status).toBe(404);
    expect(missing.body.links).toBeUndefined();
  });

  it('re-checks space access per user, caching only confirmed access', async () => {
    await request(makeApp()).get('/api/google/chat/spaces/AAA/message-links');
    await request(makeApp()).get('/api/google/chat/spaces/AAA/message-links');
    expect(googleMock.messages.list).toHaveBeenCalledTimes(1);
    googleMock.messages.list.mockRejectedValue({ response: { status: 403 } });
    const other = await request(makeApp({ authUserId: 'user-2' })).get(
      '/api/google/chat/spaces/AAA/message-links',
    );
    expect(other.status).toBe(403);
    expect(googleMock.messages.list).toHaveBeenCalledTimes(2);
  });

  it('does not create a link for a message the caller cannot read', async () => {
    addSession('gcl-1');
    googleMock.messages.get.mockRejectedValue({
      response: {
        status: 403,
        data: { error: { message: 'The caller does not have permission' } },
      },
    });
    const forbidden = await request(makeApp({ authUserId: 'user-2' }))
      .post('/api/google/chat/spaces/AAA/message-links')
      .send({ messageName: MSG, sessionId: 'gcl-1' });
    expect(forbidden.status).toBe(403);
    expect(googleMock.messages.get).toHaveBeenCalledWith({ name: MSG });

    googleMock.messages.get.mockRejectedValue({ response: { status: 404 } });
    const fabricated = await request(makeApp())
      .post('/api/google/chat/spaces/AAA/message-links')
      .send({ messageName: 'spaces/AAA/messages/FAKE', sessionId: 'gcl-1' });
    expect(fabricated.status).toBe(404);

    const count = getDb().prepare('SELECT COUNT(*) AS n FROM google_chat_message_links').get() as {
      n: number;
    };
    expect(count.n).toBe(0);
  });

  it('rejects a thread name that does not match the message', async () => {
    addSession('gcl-1');
    const res = await request(makeApp())
      .post('/api/google/chat/spaces/AAA/message-links')
      .send({ messageName: MSG, threadName: 'spaces/AAA/threads/OTHER', sessionId: 'gcl-1' });
    expect(res.status).toBe(400);
  });

  it('stamps a link replied when the session replied before the link was created', async () => {
    addSession('gcl-1');
    googleMock.spaces.get.mockResolvedValue({
      data: { spaceType: 'SPACE', spaceThreadingState: 'THREADED_MESSAGES' },
    });
    // The agent answers in another thread first, then in the linked thread,
    // all before the client's link request lands.
    googleMock.messages.create.mockResolvedValueOnce({
      data: { name: 'spaces/AAA/messages/X1', thread: { name: 'spaces/AAA/threads/OTHER' } },
    });
    googleMock.messages.create.mockResolvedValueOnce({
      data: { name: 'spaces/AAA/messages/R1', thread: { name: THREAD } },
    });
    const spawn = makeApp({ authUserId: 'user-1', authSpawnSessionId: 'gcl-1' });
    expect(
      (await request(spawn).post('/api/google/chat/spaces/AAA/messages').send({ text: 'x' }))
        .status,
    ).toBe(201);
    expect(
      (
        await request(spawn)
          .post('/api/google/chat/spaces/AAA/messages')
          .send({ text: 'Done.', threadName: THREAD })
      ).status,
    ).toBe(201);

    const created = await request(makeApp())
      .post('/api/google/chat/spaces/AAA/message-links')
      .send({ messageName: MSG, threadName: THREAD, sessionId: 'gcl-1' });
    expect(created.status).toBe(201);
    expect(created.body.link.repliedAt).toMatch(/Z$/);
    expect(created.body.link.replyMessageName).toBe('spaces/AAA/messages/R1');
  });

  it('leaves a late link unreplied when the session only posted elsewhere', async () => {
    addSession('gcl-1');
    googleMock.messages.create.mockResolvedValue({
      data: { name: 'spaces/BBB/messages/X1', thread: { name: 'spaces/BBB/threads/T' } },
    });
    await request(makeApp({ authUserId: 'user-1', authSpawnSessionId: 'gcl-1' }))
      .post('/api/google/chat/spaces/BBB/messages')
      .send({ text: 'other space' });
    const created = await request(makeApp())
      .post('/api/google/chat/spaces/AAA/message-links')
      .send({ messageName: MSG, sessionId: 'gcl-1' });
    expect(created.body.link.repliedAt).toBeNull();
  });

  it('ignores posts that name a session that does not exist', async () => {
    googleMock.messages.create.mockResolvedValue({ data: { name: 'spaces/AAA/messages/Z' } });
    const res = await request(makeApp())
      .post('/api/google/chat/spaces/AAA/messages')
      .set('X-Agent-Hub-Session-Id', 'gcl-nope')
      .send({ text: 'hi' });
    expect(res.status).toBe(201);
    const n = getDb().prepare('SELECT COUNT(*) AS n FROM google_chat_session_posts').get() as {
      n: number;
    };
    expect(n.n).toBe(0);
  });
});
