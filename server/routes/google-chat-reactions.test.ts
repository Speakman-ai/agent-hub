import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request } from 'express';
import request from 'supertest';
import type { RouteDeps } from '../types.js';

const MESSAGES_READONLY = 'https://www.googleapis.com/auth/chat.messages.readonly';
const REACTIONS = 'https://www.googleapis.com/auth/chat.messages.reactions';
const READSTATE = 'https://www.googleapis.com/auth/chat.users.readstate';
const READSTATE_RO = 'https://www.googleapis.com/auth/chat.users.readstate.readonly';

const googleMock = vi.hoisted(() => {
  const reactions = { list: vi.fn(), create: vi.fn(), delete: vi.fn() };
  const messages = { list: vi.fn(), create: vi.fn(), get: vi.fn(), reactions };
  const userSpaces = { getSpaceReadState: vi.fn(), updateSpaceReadState: vi.fn() };
  return {
    reactions,
    messages,
    userSpaces,
    chat: vi.fn(() => ({ spaces: { messages }, users: { spaces: userSpaces } })),
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

const mod = await import('./google-chat.js');
const createGoogleChatRoutes = mod.default;
const { shapeMessage } = mod;

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Request & { authUserId?: string }).authUserId = 'user-1';
    next();
  });
  app.use(
    createGoogleChatRoutes({
      config: { googleOAuth: { clientId: 'cid', clientSecret: 'secret' } },
    } as unknown as RouteDeps),
  );
  return app;
}

function grant(scopes: string[]) {
  connectionStoreMock.getGoogleConnectionStatus.mockReturnValue({
    connected: true,
    email: 'me@example.com',
    grantedScopes: scopes,
  });
}

const TOGGLE = '/api/google/chat/spaces/AAA/messages/M1.M1/reactions/toggle';

describe('Google Chat reactions and read state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grant([MESSAGES_READONLY, REACTIONS, READSTATE]);
    connectionStoreMock.getActiveAccessToken.mockResolvedValue('fresh-token');
    connectionStoreMock.getGoogleConnection.mockReturnValue({ googleSub: '999' });
  });

  it('shapes reaction summaries, keeping custom emoji and dropping empty ones', () => {
    const shaped = shapeMessage({
      name: 'spaces/AAA/messages/M1',
      text: 'hi',
      emojiReactionSummaries: [
        { emoji: { unicode: '👍' }, reactionCount: 3 },
        {
          emoji: { customEmoji: { emojiName: ':party:', temporaryImageUri: 'https://x/p.png' } },
          reactionCount: 1,
        },
        { emoji: { unicode: '😂' }, reactionCount: 0 },
        { reactionCount: 2 },
      ],
    });
    expect(shaped.reactions).toEqual([
      { emoji: '👍', customEmojiUrl: null, count: 3 },
      { emoji: ':party:', customEmojiUrl: 'https://x/p.png', count: 1 },
    ]);
    expect(shapeMessage({ name: 'x', deleteTime: 'now' }).reactions).toEqual([]);
  });

  it("returns the caller's Chat user name with a message list", async () => {
    googleMock.messages.list.mockResolvedValue({ data: { messages: [] } });
    const res = await request(makeApp()).get('/api/google/chat/spaces/AAA/messages');
    expect(res.status).toBe(200);
    expect(res.body.selfUserName).toBe('users/999');
  });

  it('adds the reaction when the caller has none with that emoji', async () => {
    googleMock.reactions.list.mockResolvedValue({ data: { reactions: [] } });
    googleMock.reactions.create.mockResolvedValue({ data: {} });
    // Another user's 👍 plus the caller's new one.
    googleMock.messages.get.mockResolvedValue({
      data: { emojiReactionSummaries: [{ emoji: { unicode: '👍' }, reactionCount: 2 }] },
    });

    const res = await request(makeApp()).post(TOGGLE).send({ emoji: '👍' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      reacted: true,
      reactions: [{ emoji: '👍', customEmojiUrl: null, count: 2 }],
    });
    // Read back only after the change was made.
    expect(googleMock.messages.get.mock.invocationCallOrder[0]).toBeGreaterThan(
      googleMock.reactions.create.mock.invocationCallOrder[0],
    );
    expect(googleMock.messages.get.mock.calls[0][0]).toEqual({
      name: 'spaces/AAA/messages/M1.M1',
    });
    expect(googleMock.reactions.list.mock.calls[0][0]).toMatchObject({
      parent: 'spaces/AAA/messages/M1.M1',
      filter: 'emoji.unicode = "👍" AND user.name = "users/999"',
    });
    expect(googleMock.reactions.create.mock.calls[0][0]).toEqual({
      parent: 'spaces/AAA/messages/M1.M1',
      requestBody: { emoji: { unicode: '👍' } },
    });
    expect(googleMock.reactions.delete).not.toHaveBeenCalled();
  });

  it("removes the caller's existing reaction instead of adding another", async () => {
    googleMock.reactions.list.mockResolvedValue({
      data: { reactions: [{ name: 'spaces/AAA/messages/M1.M1/reactions/R1' }] },
    });
    googleMock.messages.get.mockResolvedValue({ data: { emojiReactionSummaries: [] } });
    const res = await request(makeApp()).post(TOGGLE).send({ emoji: '👍' });
    expect(res.body).toEqual({ reacted: false, reactions: [] });
    expect(googleMock.reactions.delete.mock.calls[0][0]).toEqual({
      name: 'spaces/AAA/messages/M1.M1/reactions/R1',
    });
    expect(googleMock.reactions.create).not.toHaveBeenCalled();
  });

  it('refuses an emoji that could break out of the filter string', async () => {
    const res = await request(makeApp()).post(TOGGLE).send({ emoji: '" OR user.name = "x' });
    expect(res.status).toBe(400);
    expect(googleMock.reactions.list).not.toHaveBeenCalled();
  });

  it('requires the reactions scope and refuses agent sessions', async () => {
    grant([MESSAGES_READONLY]);
    const noScope = await request(makeApp()).post(TOGGLE).send({ emoji: '👍' });
    expect(noScope.status).toBe(403);
    expect(noScope.body).toMatchObject({
      code: 'google_chat_reactions_scope_required',
      requiredScopes: [REACTIONS],
    });

    grant([MESSAGES_READONLY, REACTIONS]);
    const agent = await request(makeApp())
      .post(TOGGLE)
      .set('X-Agent-Hub-Session-Id', 'sess-1')
      .send({ emoji: '👍' });
    expect(agent.status).toBe(403);
    expect(googleMock.reactions.list).not.toHaveBeenCalled();
  });

  it("reads the caller's read state, with the readonly scope enough to read", async () => {
    grant([READSTATE_RO]);
    googleMock.userSpaces.getSpaceReadState.mockResolvedValue({
      data: { lastReadTime: '2026-10-08T10:00:00.123456Z' },
    });
    const res = await request(makeApp()).get('/api/google/chat/spaces/AAA/read-state');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ lastReadTime: '2026-10-08T10:00:00.123456Z' });
    expect(googleMock.userSpaces.getSpaceReadState.mock.calls[0][0]).toEqual({
      name: 'users/me/spaces/AAA/spaceReadState',
    });

    // Marking read needs the read-write scope.
    const put = await request(makeApp())
      .put('/api/google/chat/spaces/AAA/read-state')
      .send({ lastReadTime: '2026-10-08T11:00:00Z' });
    expect(put.status).toBe(403);
    expect(put.body.code).toBe('google_chat_readstate_scope_required');
  });

  it('marks a space read up to the given time', async () => {
    googleMock.userSpaces.getSpaceReadState.mockResolvedValue({
      data: { lastReadTime: '2026-10-08T10:00:00Z' },
    });
    googleMock.userSpaces.updateSpaceReadState.mockResolvedValue({
      data: { lastReadTime: '2026-10-08T11:00:00Z' },
    });
    const res = await request(makeApp())
      .put('/api/google/chat/spaces/AAA/read-state')
      .send({ lastReadTime: '2026-10-08T11:00:00Z' });
    expect(res.status).toBe(200);
    expect(googleMock.userSpaces.updateSpaceReadState.mock.calls[0][0]).toEqual({
      name: 'users/me/spaces/AAA/spaceReadState',
      updateMask: 'lastReadTime',
      requestBody: { lastReadTime: '2026-10-08T11:00:00Z' },
    });
    expect(res.body).toEqual({ lastReadTime: '2026-10-08T11:00:00Z', updated: true });

    const bad = await request(makeApp())
      .put('/api/google/chat/spaces/AAA/read-state')
      .send({ lastReadTime: 'yesterday' });
    expect(bad.status).toBe(400);
  });

  it('never moves the read position backwards', async () => {
    // The user read through 10:10 in Google Chat; this client only knows 10:05.
    googleMock.userSpaces.getSpaceReadState.mockResolvedValue({
      data: { lastReadTime: '2026-10-08T10:10:00.123456Z' },
    });
    const res = await request(makeApp())
      .put('/api/google/chat/spaces/AAA/read-state')
      .send({ lastReadTime: '2026-10-08T10:05:00Z' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ lastReadTime: '2026-10-08T10:10:00.123456Z', updated: false });
    expect(googleMock.userSpaces.updateSpaceReadState).not.toHaveBeenCalled();

    // Same instant is not newer either.
    const same = await request(makeApp())
      .put('/api/google/chat/spaces/AAA/read-state')
      .send({ lastReadTime: '2026-10-08T10:10:00.123456Z' });
    expect(same.body.updated).toBe(false);
    expect(googleMock.userSpaces.updateSpaceReadState).not.toHaveBeenCalled();
  });

  it('does not write when the current position cannot be read', async () => {
    googleMock.userSpaces.getSpaceReadState.mockRejectedValue({ response: { status: 503 } });
    const res = await request(makeApp())
      .put('/api/google/chat/spaces/AAA/read-state')
      .send({ lastReadTime: '2026-10-08T10:05:00Z' });
    expect(res.status).toBe(502);
    expect(googleMock.userSpaces.updateSpaceReadState).not.toHaveBeenCalled();
  });

  it('serializes overlapping read-state updates so a slow older write cannot land last', async () => {
    // A stateful fake of Google's read state. The write for the older time is
    // slow, so without serialization both requests read T0, both pass the
    // forward-only check, and the older write finishes last.
    const T0 = '2026-10-08T10:00:00Z';
    const T1 = '2026-10-08T10:01:00Z';
    const T2 = '2026-10-08T10:02:00Z';
    let stored = T0;
    const writes: string[] = [];
    googleMock.userSpaces.getSpaceReadState.mockImplementation(async () => ({
      data: { lastReadTime: stored },
    }));
    googleMock.userSpaces.updateSpaceReadState.mockImplementation(
      async ({ requestBody }: { requestBody: { lastReadTime: string } }) => {
        const t = requestBody.lastReadTime;
        await new Promise((r) => setTimeout(r, t === T1 ? 60 : 5));
        stored = t;
        writes.push(t);
        return { data: { lastReadTime: t } };
      },
    );

    const app = makeApp();
    const first = request(app)
      .put('/api/google/chat/spaces/AAA/read-state')
      .send({ lastReadTime: T1 });
    const second = request(app)
      .put('/api/google/chat/spaces/AAA/read-state')
      .send({ lastReadTime: T2 });
    const [r1, r2] = await Promise.all([first, second]);

    expect(stored).toBe(T2);
    expect(writes).toEqual([T1, T2]);
    expect(r1.body).toEqual({ lastReadTime: T1, updated: true });
    expect(r2.body).toEqual({ lastReadTime: T2, updated: true });
  });

  it('a failed read-state update does not block the next one for that space', async () => {
    googleMock.userSpaces.getSpaceReadState.mockResolvedValue({ data: { lastReadTime: null } });
    googleMock.userSpaces.updateSpaceReadState
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce({ data: { lastReadTime: '2026-10-08T10:02:00Z' } });
    const app = makeApp();
    const failed = await request(app)
      .put('/api/google/chat/spaces/AAA/read-state')
      .send({ lastReadTime: '2026-10-08T10:01:00Z' });
    expect(failed.status).toBe(502);
    const ok = await request(app)
      .put('/api/google/chat/spaces/AAA/read-state')
      .send({ lastReadTime: '2026-10-08T10:02:00Z' });
    expect(ok.body).toEqual({ lastReadTime: '2026-10-08T10:02:00Z', updated: true });
  });

  it('still reports the toggle when the summary cannot be read back', async () => {
    googleMock.reactions.list.mockResolvedValue({ data: { reactions: [] } });
    googleMock.reactions.create.mockResolvedValue({ data: {} });
    googleMock.messages.get.mockRejectedValue({ response: { status: 503 } });
    const res = await request(makeApp()).post(TOGGLE).send({ emoji: '👍' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reacted: true, reactions: null });
  });

  it('serializes overlapping toggles on one message so the last answer has every change', async () => {
    // Stateful fake: the read-back snapshots Google's state when called, and
    // the first toggle's read-back is slow. Unserialized, the 👍 toggle would
    // snapshot only 👍, finish last, and its summary would drop the 🎉.
    const present = new Set<string>();
    googleMock.reactions.list.mockImplementation(async ({ filter }: { filter: string }) => {
      const emoji = /emoji.unicode = "([^"]+)"/.exec(filter)?.[1] ?? '';
      return { data: { reactions: present.has(emoji) ? [{ name: `r/${emoji}` }] : [] } };
    });
    googleMock.reactions.create.mockImplementation(
      async ({ requestBody }: { requestBody: { emoji: { unicode: string } } }) => {
        present.add(requestBody.emoji.unicode);
        return { data: {} };
      },
    );
    let gets = 0;
    googleMock.messages.get.mockImplementation(async () => {
      const snapshot = [...present].map((e) => ({ emoji: { unicode: e }, reactionCount: 1 }));
      await new Promise((r) => setTimeout(r, gets++ === 0 ? 60 : 5));
      return { data: { emojiReactionSummaries: snapshot } };
    });

    const app = makeApp();
    const finished: string[] = [];
    const bodies: Record<string, { reactions: { emoji: string }[] }> = {};
    const send = (emoji: string) =>
      request(app)
        .post(TOGGLE)
        .send({ emoji })
        .then((res) => {
          finished.push(emoji);
          bodies[emoji] = res.body;
        });
    await Promise.all([send('👍'), send('🎉')]);

    const last = bodies[finished[finished.length - 1]];
    expect(last.reactions.map((r) => r.emoji).sort()).toEqual(['🎉', '👍'].sort());
    expect(finished).toEqual(['👍', '🎉']);
  });
});
