/**
 * Agent-written Google Chat replies are held as drafts for the session owner
 * to approve. Real orgs DB for the drafts store; Google and the token store are
 * mocked so nothing leaves the process.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request } from 'express';
import request from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import type { RouteDeps } from '../types.js';

const SPACES_READONLY = 'https://www.googleapis.com/auth/chat.spaces.readonly';
const MESSAGES_READONLY = 'https://www.googleapis.com/auth/chat.messages.readonly';
const MESSAGES_CREATE = 'https://www.googleapis.com/auth/chat.messages.create';

let TMP_DIR = '';
vi.mock('../config.js', () => ({
  default: {
    apiKey: null,
    get dataDir() {
      return TMP_DIR;
    },
  },
}));

const googleMock = vi.hoisted(() => {
  const spaces = { list: vi.fn(), get: vi.fn() };
  const messages = { list: vi.fn(), create: vi.fn() };
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

const { initOrgsDb, setOrgsDbPathForTests } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { setChatSettings, claimChatDraftForSend, restartChatDraftAttemptsForTests, getChatDraft } =
  await import('../google-chat-drafts-store.js');
const createGoogleChatRoutes = (await import('./google-chat.js')).default;
const { getDb } = await import('../db.js');
const { createChatMessageLink, listChatMessageLinks } =
  await import('../google-chat-message-links-store.js');

type Caller = { userId: string; spawnSessionId?: string };

function makeApp(caller: Caller, broadcast = vi.fn()) {
  const deps = {
    config: { googleOAuth: { clientId: 'cid', clientSecret: 'secret' } },
    broadcast,
  } as unknown as RouteDeps;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const r = req as Request & { authUserId?: string; authSpawnSessionId?: string };
    r.authUserId = caller.userId;
    if (caller.spawnSessionId) r.authSpawnSessionId = caller.spawnSessionId;
    next();
  });
  app.use(createGoogleChatRoutes(deps));
  return app;
}

describe('Google Chat agent reply drafts', () => {
  let owner = '';
  let other = '';

  beforeEach(() => {
    vi.clearAllMocks();
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'google-chat-drafts-route-'));
    setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
    initOrgsDb();
    owner = createUser({ username: 'owner', passwordHash: 'x' }).id;
    other = createUser({ username: 'other', passwordHash: 'x' }).id;
    connectionStoreMock.getGoogleConnectionStatus.mockReturnValue({
      connected: true,
      grantedScopes: [SPACES_READONLY, MESSAGES_READONLY, MESSAGES_CREATE],
    });
    connectionStoreMock.getActiveAccessToken.mockResolvedValue('tok');
    googleMock.spaces.get.mockResolvedValue({
      data: { name: 'spaces/AAA', spaceType: 'SPACE', spaceThreadingState: 'THREADED_MESSAGES' },
    });
    googleMock.messages.create.mockResolvedValue({
      data: { name: 'spaces/AAA/messages/NEW', text: 'sent text' },
    });
  });

  const agent = () => ({ userId: owner, spawnSessionId: 'sess-1' });
  // The revision a client that just loaded the draft would send.
  const rev = (id: string) => getChatDraft(id, owner)?.revision ?? 1;
  const human = () => ({ userId: owner });

  async function agentDraft(broadcast = vi.fn()) {
    const res = await request(makeApp(agent(), broadcast))
      .post('/api/google/chat/spaces/AAA/messages')
      .send({ text: 'Staging is reset.', threadName: 'spaces/AAA/threads/T1' });
    return res;
  }

  it('holds an agent post as a pending draft and posts nothing', async () => {
    const broadcast = vi.fn();
    const res = await agentDraft(broadcast);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('pending_approval');
    expect(res.body.message).toMatch(/awaiting approval/);
    expect(res.body.draft).toMatchObject({
      sessionId: 'sess-1',
      spaceId: 'AAA',
      threadName: 'spaces/AAA/threads/T1',
      text: 'Staging is reset.',
      status: 'pending',
    });
    expect(res.body.draft.userId).toBeUndefined();
    expect(googleMock.messages.create).not.toHaveBeenCalled();
    expect(connectionStoreMock.getActiveAccessToken).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'google_chat_draft_update', ownerUserId: owner }),
    );
  });

  it('treats the session header (global key) as an agent caller too', async () => {
    const res = await request(makeApp(human()))
      .post('/api/google/chat/spaces/AAA/messages')
      .set('X-Agent-Hub-Session-Id', 'sess-9')
      .send({ text: 'hi' });
    expect(res.status).toBe(202);
    expect(res.body.draft.sessionId).toBe('sess-9');
    expect(googleMock.messages.create).not.toHaveBeenCalled();
  });

  it('still sends immediately for the operator in the pane', async () => {
    const res = await request(makeApp(human()))
      .post('/api/google/chat/spaces/AAA/messages')
      .send({ text: 'hi' });
    expect(res.status).toBe(201);
    expect(googleMock.messages.create).toHaveBeenCalledTimes(1);
  });

  it('sends agent posts immediately when the owner turned on auto-send', async () => {
    setChatSettings(owner, { autoSendAgentReplies: true });
    const res = await agentDraft();
    expect(res.status).toBe(201);
    expect(googleMock.messages.create).toHaveBeenCalledTimes(1);
  });

  it('refuses a draft when the send scope is missing, so approval could never post', async () => {
    connectionStoreMock.getGoogleConnectionStatus.mockReturnValue({
      connected: true,
      grantedScopes: [SPACES_READONLY],
    });
    const res = await agentDraft();
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('google_chat_send_scope_required');
  });

  it('lists pending drafts for the owner only', async () => {
    await agentDraft();
    const mine = await request(makeApp(human())).get('/api/google/chat/drafts?sessionId=sess-1');
    expect(mine.body.drafts).toHaveLength(1);
    const theirs = await request(makeApp({ userId: other })).get('/api/google/chat/drafts');
    expect(theirs.body.drafts).toEqual([]);
  });

  it('approves with edited text, posts once in the thread, and marks it sent', async () => {
    const id = (await agentDraft()).body.draft.id;
    const broadcast = vi.fn();
    const res = await request(makeApp(human(), broadcast))
      .post(`/api/google/chat/drafts/${id}/approve`)
      .send({ revision: rev(id) })
      .send({ text: 'Staging is reset, try again.' });
    expect(res.status).toBe(200);
    expect(res.body.draft).toMatchObject({
      status: 'sent',
      text: 'Staging is reset, try again.',
      sentMessageName: 'spaces/AAA/messages/NEW',
    });
    expect(googleMock.messages.create).toHaveBeenCalledWith(
      {
        parent: 'spaces/AAA',
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD',
        requestBody: {
          text: 'Staging is reset, try again.',
          thread: { name: 'spaces/AAA/threads/T1' },
        },
      },
      { timeout: 30_000 },
    );
    expect(broadcast.mock.calls.map((c) => c[0].draft.status)).toEqual(['sending', 'sent']);

    const again = await request(makeApp(human()))
      .post(`/api/google/chat/drafts/${id}/approve`)
      .send({ revision: rev(id) });
    expect(again.status).toBe(409);
    expect(googleMock.messages.create).toHaveBeenCalledTimes(1);
  });

  const approve = (id: string, body?: object) =>
    request(makeApp(human()))
      .post(`/api/google/chat/drafts/${id}/approve`)
      .send({ revision: rev(id), ...(body ?? {}) });
  const listOpen = async () =>
    (await request(makeApp(human())).get('/api/google/chat/drafts')).body.drafts;
  const createCall = (n: number) => googleMock.messages.create.mock.calls[n][0];

  it('marks the Chat message link replied only once its draft is approved and posts', async () => {
    getDb().prepare("DELETE FROM sessions WHERE id = 'sess-1'").run();
    getDb()
      .prepare('INSERT INTO sessions (id, agent_id, name) VALUES (?, ?, ?)')
      .run('sess-1', 'agent-a', 'Reset staging');
    createChatMessageLink({
      messageName: 'spaces/AAA/messages/M1',
      spaceName: 'spaces/AAA',
      threadName: 'spaces/AAA/threads/T1',
      sessionId: 'sess-1',
      userId: owner,
    });
    googleMock.messages.create.mockResolvedValue({
      data: {
        name: 'spaces/AAA/messages/R1',
        thread: { name: 'spaces/AAA/threads/T1' },
        space: { name: 'spaces/AAA' },
      },
    });

    const id = (await agentDraft()).body.draft.id;
    const linkFor = () =>
      listChatMessageLinks('spaces/AAA').find((l) => l.messageName === 'spaces/AAA/messages/M1');
    expect(linkFor()?.repliedAt).toBeNull();

    expect((await approve(id)).status).toBe(200);
    expect(linkFor()).toMatchObject({ replyMessageName: 'spaces/AAA/messages/R1' });
    expect(linkFor()?.repliedAt).toMatch(/Z$/);
  });

  it('returns a refused send to pending, and the next attempt is a new request', async () => {
    const id = (await agentDraft()).body.draft.id;
    googleMock.messages.create.mockRejectedValueOnce({ response: { status: 429 } });
    expect((await approve(id)).status).toBe(429);
    expect((await listOpen())[0]).toMatchObject({ status: 'pending', error: expect.any(String) });

    // Editing a refused draft is fine: nothing was posted.
    await request(makeApp(human()))
      .patch(`/api/google/chat/drafts/${id}`)
      .send({ revision: rev(id) })
      .send({ text: 'v2' });
    expect((await approve(id)).status).toBe(200);
    expect(createCall(1).requestBody.text).toBe('v2');
    expect(createCall(1).requestId).not.toBe(createCall(0).requestId);
  });

  it('a send whose response was lost stays unconfirmed and retries the identical request', async () => {
    const id = (await agentDraft()).body.draft.id;
    // Google accepted the message but the connection dropped before the reply.
    googleMock.messages.create.mockRejectedValueOnce(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    );
    expect((await approve(id)).status).toBe(502);
    const [held] = await listOpen();
    expect(held).toMatchObject({
      status: 'unconfirmed',
      error: expect.stringMatching(/may have posted/),
    });
    expect(held.requestId).toBeUndefined();

    // The text of a possibly-posted message can't change, by edit or approve.
    const edit = await request(makeApp(human()))
      .patch(`/api/google/chat/drafts/${id}`)
      .send({ revision: rev(id) })
      .send({ text: 'different' });
    expect(edit.status).toBe(409);
    const changed = await approve(id, { text: 'different' });
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('google_chat_draft_unconfirmed');
    expect(googleMock.messages.create).toHaveBeenCalledTimes(1);

    // Even a 4xx on the retry keeps it unconfirmed: the first attempt may have posted.
    googleMock.messages.create.mockRejectedValueOnce({ response: { status: 429 } });
    expect((await approve(id)).status).toBe(429);
    expect((await listOpen())[0].status).toBe('unconfirmed');

    const retry = await approve(id);
    expect(retry.status).toBe(200);
    expect(retry.body.draft.status).toBe('sent');
    expect(googleMock.messages.create).toHaveBeenCalledTimes(3);
    for (const n of [1, 2]) {
      expect(createCall(n)).toEqual(createCall(0));
    }
    expect(createCall(0).requestId).toMatch(/^[0-9a-f-]{36}$/);
    // The retry reuses the thread decision instead of re-reading the space.
    expect(googleMock.spaces.get).toHaveBeenCalledTimes(1);
  });

  it('after a restart mid-send, the draft is unconfirmed and a retry repeats the request', async () => {
    const id = (await agentDraft()).body.draft.id;
    // The approval claimed the attempt, then the server died before Google answered.
    const claim = claimChatDraftForSend(id, owner, {
      expectedRevision: 1,
      replyThread: 'spaces/AAA/threads/T1',
    });
    if (!claim.ok) throw new Error('claim failed');
    restartChatDraftAttemptsForTests();

    const [held] = await listOpen();
    expect(held).toMatchObject({
      status: 'unconfirmed',
      error: expect.stringMatching(/restarted/),
    });
    const edit = await request(makeApp(human()))
      .patch(`/api/google/chat/drafts/${id}`)
      .send({ revision: rev(id) })
      .send({ text: 'different' });
    expect(edit.status).toBe(409);

    const retry = await approve(id);
    expect(retry.status).toBe(200);
    expect(retry.body.draft.status).toBe('sent');
    expect(createCall(0)).toMatchObject({
      requestId: claim.attempt.requestId,
      requestBody: { text: 'Staging is reset.', thread: { name: 'spaces/AAA/threads/T1' } },
    });
    expect(googleMock.spaces.get).not.toHaveBeenCalled();
  });

  it('a 5xx from Google is treated as unconfirmed, not refused', async () => {
    const id = (await agentDraft()).body.draft.id;
    googleMock.messages.create.mockRejectedValueOnce({ response: { status: 503 } });
    await approve(id);
    expect((await listOpen())[0].status).toBe('unconfirmed');
  });

  it('a failure reading the space before posting returns the draft to pending', async () => {
    const id = (await agentDraft()).body.draft.id;
    googleMock.spaces.get.mockRejectedValueOnce(new Error('socket hang up'));
    await approve(id);
    expect((await listOpen())[0].status).toBe('pending');
    expect(googleMock.messages.create).not.toHaveBeenCalled();
  });

  it('discards an unconfirmed draft and lists open drafts with the read time', async () => {
    const id = (await agentDraft()).body.draft.id;
    googleMock.messages.create.mockRejectedValueOnce(new Error('timeout'));
    await approve(id);
    const list = await request(makeApp(human())).get('/api/google/chat/drafts');
    expect(list.body.asOf).toMatch(/Z$/);
    expect(list.body.drafts).toHaveLength(1);
    const res = await request(makeApp(human()))
      .post(`/api/google/chat/drafts/${id}/discard`)
      .send({ revision: rev(id) });
    expect(res.body.draft.status).toBe('discarded');
  });

  it('refuses to post text the approver did not review when another tab edited it', async () => {
    const id = (await agentDraft()).body.draft.id;
    const reviewed = rev(id);
    // Tab B edits while tab A is looking at the original.
    const editB = await request(makeApp(human()))
      .patch(`/api/google/chat/drafts/${id}`)
      .send({ text: 'Tab B text', revision: reviewed });
    expect(editB.body.draft.revision).toBe(reviewed + 1);

    const approveA = await request(makeApp(human()))
      .post(`/api/google/chat/drafts/${id}/approve`)
      .send({ revision: reviewed });
    expect(approveA.status).toBe(409);
    expect(approveA.body.code).toBe('google_chat_draft_changed');
    expect(approveA.body.draft).toMatchObject({ text: 'Tab B text', revision: reviewed + 1 });
    expect(googleMock.messages.create).not.toHaveBeenCalled();

    // A stale edit or discard is refused the same way.
    const staleEdit = await request(makeApp(human()))
      .patch(`/api/google/chat/drafts/${id}`)
      .send({ text: 'Tab A text', revision: reviewed });
    expect(staleEdit.body.code).toBe('google_chat_draft_changed');
    const staleDiscard = await request(makeApp(human()))
      .post(`/api/google/chat/drafts/${id}/discard`)
      .send({ revision: reviewed });
    expect(staleDiscard.body.code).toBe('google_chat_draft_changed');

    // Approving what is now shown posts exactly that.
    const ok = await request(makeApp(human()))
      .post(`/api/google/chat/drafts/${id}/approve`)
      .send({ revision: reviewed + 1 });
    expect(ok.status).toBe(200);
    expect(createCall(0).requestBody.text).toBe('Tab B text');
  });

  it('refuses an approval whose draft is edited during the token and thread lookup', async () => {
    const id = (await agentDraft()).body.draft.id;
    const reviewed = rev(id);
    // The edit lands while approval waits on Google for the space.
    googleMock.spaces.get.mockImplementationOnce(async () => {
      await request(makeApp(human()))
        .patch(`/api/google/chat/drafts/${id}`)
        .send({ text: 'Edited mid-approval', revision: reviewed });
      return {
        data: { name: 'spaces/AAA', spaceType: 'SPACE', spaceThreadingState: 'THREADED_MESSAGES' },
      };
    });
    const res = await request(makeApp(human()))
      .post(`/api/google/chat/drafts/${id}/approve`)
      .send({ revision: reviewed });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('google_chat_draft_changed');
    expect(googleMock.messages.create).not.toHaveBeenCalled();
    expect((await listOpen())[0]).toMatchObject({ status: 'pending', text: 'Edited mid-approval' });
  });

  it('requires the reviewed revision on approve, edit, and discard', async () => {
    const id = (await agentDraft()).body.draft.id;
    const app = makeApp(human());
    expect((await request(app).post(`/api/google/chat/drafts/${id}/approve`).send({})).status).toBe(
      400,
    );
    expect(
      (await request(app).patch(`/api/google/chat/drafts/${id}`).send({ text: 'x' })).status,
    ).toBe(400);
    expect((await request(app).post(`/api/google/chat/drafts/${id}/discard`).send({})).status).toBe(
      400,
    );
  });

  it('edits and discards a draft; another user cannot touch it', async () => {
    const id = (await agentDraft()).body.draft.id;
    const edit = await request(makeApp(human()))
      .patch(`/api/google/chat/drafts/${id}`)
      .send({ revision: rev(id) })
      .send({ text: 'New text' });
    expect(edit.body.draft.text).toBe('New text');

    const stranger = await request(makeApp({ userId: other }))
      .post(`/api/google/chat/drafts/${id}/discard`)
      .send({ revision: rev(id) });
    expect(stranger.status).toBe(404);

    const discard = await request(makeApp(human()))
      .post(`/api/google/chat/drafts/${id}/discard`)
      .send({ revision: rev(id) });
    expect(discard.body.draft.status).toBe('discarded');
    const approve = await request(makeApp(human()))
      .post(`/api/google/chat/drafts/${id}/approve`)
      .send({ revision: rev(id) });
    expect(approve.status).toBe(409);
    expect(googleMock.messages.create).not.toHaveBeenCalled();
  });

  it('never lets an agent approve, edit, discard, or turn on auto-send', async () => {
    const id = (await agentDraft()).body.draft.id;
    const app = makeApp(agent());
    for (const res of [
      await request(app)
        .post(`/api/google/chat/drafts/${id}/approve`)
        .send({ revision: rev(id) }),
      await request(app)
        .patch(`/api/google/chat/drafts/${id}`)
        .send({ revision: rev(id) })
        .send({ text: 'x' }),
      await request(app)
        .post(`/api/google/chat/drafts/${id}/discard`)
        .send({ revision: rev(id) }),
      await request(app).put('/api/google/chat/settings').send({ autoSendAgentReplies: true }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('google_chat_human_approval_required');
    }
    expect(googleMock.messages.create).not.toHaveBeenCalled();
    const settings = await request(makeApp(human())).get('/api/google/chat/settings');
    expect(settings.body).toEqual({ autoSendAgentReplies: false });
  });

  it('reads and writes the auto-send setting for the operator', async () => {
    const app = makeApp(human());
    expect((await request(app).get('/api/google/chat/settings')).body).toEqual({
      autoSendAgentReplies: false,
    });
    const put = await request(app)
      .put('/api/google/chat/settings')
      .send({ autoSendAgentReplies: true });
    expect(put.body).toEqual({ autoSendAgentReplies: true });
    expect(
      (await request(app).put('/api/google/chat/settings').send({ autoSendAgentReplies: 'yes' }))
        .status,
    ).toBe(400);
  });
});
