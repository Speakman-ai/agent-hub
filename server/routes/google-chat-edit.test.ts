import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request } from 'express';
import request from 'supertest';
import type { RouteDeps } from '../types.js';

const MESSAGES_READONLY = 'https://www.googleapis.com/auth/chat.messages.readonly';
const MESSAGES_CREATE = 'https://www.googleapis.com/auth/chat.messages.create';
const MESSAGES_FULL = 'https://www.googleapis.com/auth/chat.messages';

const googleMock = vi.hoisted(() => {
  const messages = { list: vi.fn(), create: vi.fn(), get: vi.fn(), patch: vi.fn() };
  return {
    messages,
    chat: vi.fn(() => ({ spaces: { messages } })),
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

const { default: createGoogleChatRoutes } = await import('./google-chat.js');

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

const EDIT = '/api/google/chat/spaces/AAA/messages/M1.M1';
const NAME = 'spaces/AAA/messages/M1.M1';

function current(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      name: NAME,
      text: 'old text',
      createTime: '2026-10-09T10:00:00Z',
      sender: { name: 'users/999', type: 'HUMAN' },
      emojiReactionSummaries: [{ emoji: { unicode: '👍' }, reactionCount: 2 }],
      ...overrides,
    },
  };
}

describe('PATCH /api/google/chat/spaces/:spaceId/messages/:messageId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grant([MESSAGES_READONLY, MESSAGES_FULL]);
    connectionStoreMock.getActiveAccessToken.mockResolvedValue('fresh-token');
    connectionStoreMock.getGoogleConnection.mockReturnValue({ googleSub: '999' });
  });

  it('patches only the text of the caller’s own message and returns it shaped', async () => {
    googleMock.messages.get.mockResolvedValue(current());
    googleMock.messages.patch.mockResolvedValue({
      data: { name: NAME, text: 'new text', lastUpdateTime: '2026-10-09T10:05:00Z' },
    });

    const res = await request(makeApp()).patch(EDIT).send({ text: '  new text  ' });

    expect(res.status).toBe(200);
    expect(googleMock.messages.patch).toHaveBeenCalledWith(
      { name: NAME, updateMask: 'text', requestBody: { text: 'new text' } },
      expect.any(Object),
    );
    expect(res.body).toMatchObject({
      name: NAME,
      text: 'new text',
      lastUpdateTime: '2026-10-09T10:05:00Z',
      sender: { name: 'users/999' },
      // Fields the patch response omitted come from the message read first.
      reactions: [{ emoji: '👍', count: 2 }],
    });
  });

  it('applies concurrent edits to one message in the order they arrived', async () => {
    googleMock.messages.get.mockResolvedValue(current());
    let releaseFirst!: () => void;
    googleMock.messages.patch
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () => resolve({ data: { name: NAME, text: 'first' } });
          }),
      )
      .mockResolvedValueOnce({ data: { name: NAME, text: 'second' } });

    const app = makeApp();
    const first = request(app)
      .patch(EDIT)
      .send({ text: 'first' })
      .then((r) => r);
    await vi.waitFor(() => expect(googleMock.messages.patch).toHaveBeenCalledTimes(1));
    const second = request(app)
      .patch(EDIT)
      .send({ text: 'second' })
      .then((r) => r);
    // The second edit waits behind the first instead of racing it to Google.
    await new Promise((r) => setTimeout(r, 30));
    expect(googleMock.messages.patch).toHaveBeenCalledTimes(1);

    releaseFirst();
    const [a, b] = await Promise.all([first, second]);
    expect(a.body.text).toBe('first');
    expect(b.body.text).toBe('second');
    expect(googleMock.messages.patch.mock.calls.map((c) => c[0].requestBody.text)).toEqual([
      'first',
      'second',
    ]);
  });

  it('refuses a message someone else sent without calling patch', async () => {
    googleMock.messages.get.mockResolvedValue(current({ sender: { name: 'users/123' } }));

    const res = await request(makeApp()).patch(EDIT).send({ text: 'hijack' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('google_chat_not_own_message');
    expect(googleMock.messages.patch).not.toHaveBeenCalled();
  });

  it('refuses a deleted message', async () => {
    googleMock.messages.get.mockResolvedValue(current({ deleteTime: '2026-10-09T10:01:00Z' }));

    const res = await request(makeApp()).patch(EDIT).send({ text: 'x' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('google_chat_message_deleted');
    expect(googleMock.messages.patch).not.toHaveBeenCalled();
  });

  it('asks for the chat.messages scope when only create was granted', async () => {
    grant([MESSAGES_READONLY, MESSAGES_CREATE]);

    const res = await request(makeApp()).patch(EDIT).send({ text: 'x' });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'google_chat_edit_scope_required',
      requiredScopes: [MESSAGES_FULL],
    });
    expect(googleMock.messages.get).not.toHaveBeenCalled();
  });

  it('refuses agent sessions, whose edits would skip owner review', async () => {
    const res = await request(makeApp())
      .patch(EDIT)
      .set('X-Agent-Hub-Session-Id', 'sess-1')
      .send({ text: 'x' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('google_chat_human_approval_required');
    expect(googleMock.messages.get).not.toHaveBeenCalled();
  });

  it('rejects empty text and unknown fields', async () => {
    expect((await request(makeApp()).patch(EDIT).send({ text: '   ' })).status).toBe(400);
    expect((await request(makeApp()).patch(EDIT).send({ text: 'a', cards: [] })).status).toBe(400);
  });

  it('maps a Google 404 to not found', async () => {
    googleMock.messages.get.mockRejectedValue({ response: { status: 404, data: {} } });

    const res = await request(makeApp()).patch(EDIT).send({ text: 'x' });

    expect(res.status).toBe(404);
  });
});
