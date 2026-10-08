import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request } from 'express';
import request from 'supertest';
import type { RouteDeps } from '../types.js';

const SPACES_READONLY = 'https://www.googleapis.com/auth/chat.spaces.readonly';
const MESSAGES_READONLY = 'https://www.googleapis.com/auth/chat.messages.readonly';
const MESSAGES_CREATE = 'https://www.googleapis.com/auth/chat.messages.create';

const googleMock = vi.hoisted(() => {
  const spaces = { list: vi.fn(), get: vi.fn() };
  const members = { list: vi.fn() };
  const messages = { list: vi.fn(), create: vi.fn() };
  const setCredentials = vi.fn();
  return {
    spaces,
    messages,
    setCredentials,
    members,
    chat: vi.fn(() => ({ spaces: { ...spaces, messages, members } })),
    OAuth2: vi.fn(function OAuth2() {
      return { setCredentials };
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
const { clearChatParticipantCache } = await import('../google-chat-participants.js');
const createGoogleChatRoutes = mod.default;
const { extractGoogleError } = mod;

function buildDeps(): RouteDeps {
  return {
    config: { googleOAuth: { clientId: 'cid', clientSecret: 'secret' } },
  } as unknown as RouteDeps;
}

function makeApp(authUserId: string | null = 'user-1', deps = buildDeps()): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (authUserId) (req as Request & { authUserId?: string }).authUserId = authUserId;
    next();
  });
  app.use(createGoogleChatRoutes(deps));
  return app;
}

function connected(scopes = [SPACES_READONLY, MESSAGES_READONLY, MESSAGES_CREATE]) {
  return { connected: true, email: 'me@example.com', grantedScopes: scopes };
}

describe('Google Chat proxy routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectionStoreMock.getGoogleConnectionStatus.mockReturnValue(connected());
    connectionStoreMock.getActiveAccessToken.mockResolvedValue('fresh-token');
    connectionStoreMock.getGoogleConnection.mockReturnValue({ googleSub: '999' });
    clearChatParticipantCache();
  });

  it('lists spaces sorted by most recent activity without leaking the token', async () => {
    googleMock.spaces.list.mockResolvedValue({
      data: {
        spaces: [
          {
            name: 'spaces/OLD',
            displayName: 'Old',
            spaceType: 'SPACE',
            lastActiveTime: '2026-10-01T00:00:00Z',
          },
          {
            name: 'spaces/DM1',
            spaceType: 'DIRECT_MESSAGE',
            lastActiveTime: '2026-10-07T00:00:00Z',
            spaceUri: 'https://chat.google.com/dm/DM1',
          },
          { name: 'spaces/NEVER', displayName: 'Quiet', spaceType: 'SPACE' },
        ],
        nextPageToken: 'next',
      },
    });

    const res = await request(makeApp()).get('/api/google/chat/spaces');

    expect(res.status).toBe(200);
    expect(res.body.spaces.map((s: { id: string }) => s.id)).toEqual(['DM1', 'OLD', 'NEVER']);
    expect(res.body.spaces[0]).toMatchObject({
      name: 'spaces/DM1',
      displayName: null,
      spaceType: 'DIRECT_MESSAGE',
      spaceUri: 'https://chat.google.com/dm/DM1',
    });
    expect(res.body.nextPageToken).toBe('next');
    expect(googleMock.setCredentials).toHaveBeenCalledWith({ access_token: 'fresh-token' });
    expect(JSON.stringify(res.body)).not.toContain('fresh-token');
  });

  it('returns 403 with the required scope when Chat has not been enabled', async () => {
    connectionStoreMock.getGoogleConnectionStatus.mockReturnValue(connected(['openid']));
    const res = await request(makeApp()).get('/api/google/chat/spaces');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'google_chat_scope_required',
      requiredScopes: [SPACES_READONLY],
    });
    expect(googleMock.spaces.list).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated and 401 when Google is not linked', async () => {
    expect((await request(makeApp(null)).get('/api/google/chat/spaces')).status).toBe(401);
    connectionStoreMock.getGoogleConnectionStatus.mockReturnValue({ connected: false });
    const res = await request(makeApp()).get('/api/google/chat/spaces');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('google_not_connected');
  });

  it('lists messages newest-first and shapes sender, thread, and attachments', async () => {
    googleMock.messages.list.mockResolvedValue({
      data: {
        messages: [
          {
            name: 'spaces/AAA/messages/M1.M1',
            text: 'Can you reset the staging DB?',
            createTime: '2026-10-08T10:00:00Z',
            sender: { name: 'users/123', type: 'HUMAN' },
            thread: { name: 'spaces/AAA/threads/T1' },
            space: { name: 'spaces/AAA' },
            attachment: [{ name: 'a' }],
          },
          {
            name: 'spaces/AAA/messages/M0',
            deleteTime: '2026-10-08T09:00:00Z',
            sender: { name: 'users/456', displayName: 'Bot', type: 'BOT' },
          },
        ],
      },
    });

    const res = await request(makeApp()).get('/api/google/chat/spaces/AAA/messages?pageSize=10');

    expect(res.status).toBe(200);
    expect(googleMock.messages.list).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: 'spaces/AAA',
        pageSize: 10,
        orderBy: 'createTime desc',
        showDeleted: true,
      }),
    );
    expect(res.body.messages[0]).toEqual({
      name: 'spaces/AAA/messages/M1.M1',
      id: 'M1.M1',
      spaceName: 'spaces/AAA',
      threadName: 'spaces/AAA/threads/T1',
      threadReply: false,
      text: 'Can you reset the staging DB?',
      createTime: '2026-10-08T10:00:00Z',
      lastUpdateTime: null,
      deleted: false,
      attachmentCount: 1,
      sender: { name: 'users/123', displayName: null, type: 'HUMAN' },
    });
    expect(res.body.messages[1]).toMatchObject({ deleted: true, text: null });
    expect(res.body.nextPageToken).toBeNull();
  });

  it('filters by thread and rejects a thread from another space', async () => {
    googleMock.messages.list.mockResolvedValue({ data: {} });
    const ok = await request(makeApp()).get(
      '/api/google/chat/spaces/AAA/messages?threadName=spaces/AAA/threads/T1',
    );
    expect(ok.status).toBe(200);
    expect(googleMock.messages.list).toHaveBeenCalledWith(
      expect.objectContaining({ filter: 'thread.name = spaces/AAA/threads/T1' }),
    );

    const cross = await request(makeApp()).get(
      '/api/google/chat/spaces/AAA/messages?threadName=spaces/BBB/threads/T1',
    );
    expect(cross.status).toBe(400);
  });

  it('rejects space ids that could escape the resource name', async () => {
    const res = await request(makeApp()).get('/api/google/chat/spaces/..%2Fusers/messages');
    expect(res.status).toBe(400);
    expect(googleMock.messages.list).not.toHaveBeenCalled();
  });

  it('posts a thread reply with the fallback-to-new-thread option in a threaded named space', async () => {
    googleMock.spaces.get.mockResolvedValue({
      data: { name: 'spaces/AAA', spaceType: 'SPACE', spaceThreadingState: 'THREADED_MESSAGES' },
    });
    googleMock.messages.create.mockResolvedValue({
      data: {
        name: 'spaces/AAA/messages/NEW',
        text: 'On it',
        thread: { name: 'spaces/AAA/threads/T1' },
        threadReply: true,
      },
    });

    const res = await request(makeApp())
      .post('/api/google/chat/spaces/AAA/messages')
      .send({ text: 'On it', threadName: 'spaces/AAA/threads/T1' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'NEW', threadReply: true, text: 'On it' });
    expect(googleMock.messages.create).toHaveBeenCalledWith({
      parent: 'spaces/AAA',
      messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD',
      requestBody: { text: 'On it', thread: { name: 'spaces/AAA/threads/T1' } },
    });
    expect(googleMock.spaces.get).toHaveBeenCalledWith({ name: 'spaces/AAA' });
  });

  it.each([
    ['DIRECT_MESSAGE', undefined],
    ['GROUP_CHAT', 'UNTHREADED_MESSAGES'],
    ['SPACE', 'UNTHREADED_MESSAGES'],
  ])(
    'sends an ordinary message when a %s (%s) gets a threadName',
    async (spaceType, spaceThreadingState) => {
      googleMock.spaces.get.mockResolvedValue({
        data: { name: 'spaces/AAA', spaceType, spaceThreadingState },
      });
      googleMock.messages.create.mockResolvedValue({
        data: { name: 'spaces/AAA/messages/NEW', text: 'On it' },
      });

      const res = await request(makeApp())
        .post('/api/google/chat/spaces/AAA/messages')
        .send({ text: 'On it', threadName: 'spaces/AAA/threads/T1' });

      expect(res.status).toBe(201);
      expect(googleMock.messages.create).toHaveBeenCalledWith({
        parent: 'spaces/AAA',
        requestBody: { text: 'On it' },
      });
    },
  );

  it('plain sends never read the space', async () => {
    googleMock.messages.create.mockResolvedValue({ data: { name: 'spaces/AAA/messages/NEW' } });
    const res = await request(makeApp())
      .post('/api/google/chat/spaces/AAA/messages')
      .send({ text: 'hello' });
    expect(res.status).toBe(201);
    expect(googleMock.spaces.get).not.toHaveBeenCalled();
  });

  it('a thread reply without the spaces read scope is refused with the scope to request', async () => {
    connectionStoreMock.getGoogleConnectionStatus.mockReturnValue(connected([MESSAGES_CREATE]));
    const res = await request(makeApp())
      .post('/api/google/chat/spaces/AAA/messages')
      .send({ text: 'On it', threadName: 'spaces/AAA/threads/T1' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'google_chat_scope_required',
      requiredScopes: [SPACES_READONLY],
    });
    expect(googleMock.messages.create).not.toHaveBeenCalled();
  });

  it('marks only threaded named spaces as supporting thread replies', async () => {
    googleMock.spaces.list.mockResolvedValue({
      data: {
        spaces: [
          { name: 'spaces/S1', spaceType: 'SPACE', spaceThreadingState: 'THREADED_MESSAGES' },
          { name: 'spaces/S2', spaceType: 'SPACE', spaceThreadingState: 'GROUPED_MESSAGES' },
          { name: 'spaces/S3', spaceType: 'SPACE', spaceThreadingState: 'UNTHREADED_MESSAGES' },
          { name: 'spaces/D1', spaceType: 'DIRECT_MESSAGE' },
          {
            name: 'spaces/G1',
            spaceType: 'GROUP_CHAT',
            spaceThreadingState: 'UNTHREADED_MESSAGES',
          },
        ],
      },
    });
    const res = await request(makeApp()).get('/api/google/chat/spaces');
    const byId = Object.fromEntries(
      res.body.spaces.map((sp: { id: string; supportsThreadReplies: boolean }) => [
        sp.id,
        sp.supportsThreadReplies,
      ]),
    );
    expect(byId).toEqual({ S1: true, S2: true, S3: false, D1: false, G1: false });
  });

  it('requires the create scope to post and rejects empty text', async () => {
    const empty = await request(makeApp())
      .post('/api/google/chat/spaces/AAA/messages')
      .send({ text: '   ' });
    expect(empty.status).toBe(400);

    connectionStoreMock.getGoogleConnectionStatus.mockReturnValue(
      connected([SPACES_READONLY, MESSAGES_READONLY]),
    );
    const res = await request(makeApp())
      .post('/api/google/chat/spaces/AAA/messages')
      .send({ text: 'hi' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'google_chat_send_scope_required',
      requiredScopes: [MESSAGES_CREATE],
    });
  });

  it('maps upstream errors: 403 passes the Google reason through, quota becomes 429', async () => {
    googleMock.spaces.list.mockRejectedValueOnce({
      response: {
        status: 403,
        data: { error: { message: 'The caller does not have permission\nmore detail' } },
      },
    });
    const forbidden = await request(makeApp()).get('/api/google/chat/spaces');
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toEqual({
      code: 'google_chat_forbidden',
      error: 'The caller does not have permission',
    });

    googleMock.spaces.list.mockRejectedValueOnce({
      response: { status: 403, data: { error: { message: 'Quota exceeded for quota metric' } } },
    });
    const limited = await request(makeApp()).get('/api/google/chat/spaces');
    expect(limited.status).toBe(429);
  });

  // Google's responses for the three setup failures, as documented in
  // https://developers.google.com/workspace/chat/troubleshoot-chat-apps and
  // the googleapis ErrorInfo shape.
  it('maps a missing Chat app (Google 404) to a setup error, not "resource not found"', async () => {
    googleMock.spaces.list.mockRejectedValueOnce({
      response: {
        status: 404,
        data: {
          error: {
            code: 404,
            status: 'NOT_FOUND',
            message:
              'Google Chat app not found. To create a Chat app, you must turn on the Chat API and configure the app in the Google Cloud console.',
          },
        },
      },
    });
    const res = await request(makeApp()).get('/api/google/chat/spaces');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('google_chat_app_not_configured');
    expect(res.body.error).toMatch(/no Chat app is configured/);
    expect(res.body.helpUrl).toBe(
      'https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat',
    );
  });

  it('maps SERVICE_DISABLED to an enable-the-API error carrying the activation URL', async () => {
    const activationUrl =
      'https://console.developers.google.com/apis/api/chat.googleapis.com/overview?project=123';
    googleMock.messages.list.mockRejectedValueOnce({
      response: {
        status: 403,
        data: {
          error: {
            code: 403,
            status: 'PERMISSION_DENIED',
            message: `Google Chat API has not been used in project 123 before or it is disabled. Enable it by visiting ${activationUrl} then retry.`,
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: 'SERVICE_DISABLED',
                metadata: { service: 'chat.googleapis.com', activationUrl },
              },
            ],
          },
        },
      },
    });
    const res = await request(makeApp()).get('/api/google/chat/spaces/AAA/messages');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'google_chat_api_disabled', helpUrl: activationUrl });
    expect(res.body.error).toMatch(/turned off/);
  });

  it('recognizes the legacy accessNotConfigured reason and ignores non-console activation URLs', () => {
    const mapped = extractGoogleError({
      response: {
        status: 403,
        data: {
          error: {
            message: 'Access Not Configured.',
            errors: [{ reason: 'accessNotConfigured' }],
            details: [
              { reason: 'SERVICE_DISABLED', metadata: { activationUrl: 'https://evil.example/x' } },
            ],
          },
        },
      },
    });
    expect(mapped.code).toBe('google_chat_api_disabled');
    expect(mapped.helpUrl).toBe(
      'https://console.cloud.google.com/apis/library/chat.googleapis.com',
    );
  });

  it('maps a personal (consumer) account to a Workspace-required error on send', async () => {
    googleMock.messages.create.mockRejectedValueOnce({
      response: {
        status: 403,
        data: {
          error: { message: 'Google Chat API is only available to Google Workspace users.' },
        },
      },
    });
    const res = await request(makeApp())
      .post('/api/google/chat/spaces/AAA/messages')
      .send({ text: 'hi' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('google_chat_workspace_required');
    expect(res.body.error).toMatch(/Reconnect with a work account/);
  });

  it('does not mistake a Workspace admin turning Chat off for the API being disabled', () => {
    const mapped = extractGoogleError({
      response: {
        status: 403,
        data: { error: { message: 'Google Chat is disabled for this user.' } },
      },
    });
    expect(mapped.code).toBe('google_chat_forbidden');
    expect(mapped.helpUrl).toBeUndefined();
  });

  it('re-reads a time range with since/until and returns deletions as content-free tombstones', async () => {
    googleMock.messages.list.mockResolvedValue({
      data: {
        messages: [
          {
            name: 'spaces/AAA/messages/GONE',
            text: 'should never be shown',
            deleteTime: '2026-10-08T10:30:00Z',
            createTime: '2026-10-08T10:00:00Z',
          },
        ],
      },
    });

    const res = await request(makeApp()).get(
      '/api/google/chat/spaces/AAA/messages?since=2026-10-08T09:00:00.123900Z&until=2026-10-08T12:00:00.123456Z&threadName=spaces/AAA/threads/T1',
    );

    expect(res.status).toBe(200);
    expect(googleMock.messages.list).toHaveBeenCalledWith(
      expect.objectContaining({
        showDeleted: true,
        filter:
          // Inclusive bounds, widened by exactly 1 ns, sub-millisecond digits intact.
          'createTime > "2026-10-08T09:00:00.123899999Z" AND createTime < "2026-10-08T12:00:00.123456001Z" AND thread.name = spaces/AAA/threads/T1',
      }),
    );
    expect(res.body.messages[0]).toMatchObject({ deleted: true, text: null });
  });

  it('rejects a non-RFC 3339 since', async () => {
    const res = await request(makeApp()).get(
      '/api/google/chat/spaces/AAA/messages?since=yesterday',
    );
    expect(res.status).toBe(400);
    const noZone = await request(makeApp()).get(
      '/api/google/chat/spaces/AAA/messages?until=2026-10-08T10:00:00',
    );
    expect(noZone.status).toBe(400);
    // Impossible dates must not roll over into a real instant (Feb 30 -> Mar 2).
    const feb30 = await request(makeApp()).get(
      '/api/google/chat/spaces/AAA/messages?since=2026-02-30T00:00:00Z',
    );
    expect(feb30.status).toBe(400);
    expect(googleMock.messages.list).not.toHaveBeenCalled();
  });

  const MEMBERSHIPS = 'https://www.googleapis.com/auth/chat.memberships.readonly';

  it('names unnamed DMs and group chats by their other members, caller excluded', async () => {
    connectionStoreMock.getGoogleConnectionStatus.mockReturnValue(
      connected([SPACES_READONLY, MESSAGES_READONLY, MEMBERSHIPS]),
    );
    googleMock.spaces.list.mockResolvedValue({
      data: {
        spaces: [
          { name: 'spaces/DM1', spaceType: 'DIRECT_MESSAGE' },
          { name: 'spaces/DM2', spaceType: 'DIRECT_MESSAGE' },
          { name: 'spaces/G1', spaceType: 'GROUP_CHAT' },
          { name: 'spaces/NAMED', spaceType: 'SPACE', displayName: 'Support' },
        ],
      },
    });
    const self = { member: { name: 'users/999', displayName: 'Me', type: 'HUMAN' } };
    googleMock.members.list.mockImplementation(async ({ parent }: { parent: string }) => ({
      data: {
        memberships:
          parent === 'spaces/DM1'
            ? [self, { member: { name: 'users/1', displayName: 'Dana Ruiz', type: 'HUMAN' } }]
            : parent === 'spaces/DM2'
              ? [self, { member: { name: 'users/2', displayName: 'Lee Chen', type: 'HUMAN' } }]
              : [
                  self,
                  { member: { name: 'users/1', displayName: 'Dana Ruiz', type: 'HUMAN' } },
                  { member: { name: 'users/3', displayName: 'Sam Ito', type: 'HUMAN' } },
                ],
      },
    }));

    const res = await request(makeApp()).get('/api/google/chat/spaces');

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(
      res.body.spaces.map((s: { id: string; participants: string[] | null }) => [
        s.id,
        s.participants,
      ]),
    );
    expect(byId).toEqual({
      DM1: ['Dana Ruiz'],
      DM2: ['Lee Chen'],
      G1: ['Dana Ruiz', 'Sam Ito'],
      NAMED: null,
    });
    expect(googleMock.members.list).toHaveBeenCalledTimes(3);
    expect(googleMock.members.list).toHaveBeenCalledWith({
      parent: 'spaces/DM1',
      pageSize: 1000,
      filter: 'member.type = "HUMAN"',
    });

    // Second load is served from the cache.
    await request(makeApp()).get('/api/google/chat/spaces');
    expect(googleMock.members.list).toHaveBeenCalledTimes(3);
  });

  it('leaves participants null without the memberships scope, and on lookup failure', async () => {
    googleMock.spaces.list.mockResolvedValue({
      data: { spaces: [{ name: 'spaces/DM1', spaceType: 'DIRECT_MESSAGE' }] },
    });
    const noScope = await request(makeApp()).get('/api/google/chat/spaces');
    expect(noScope.body.spaces[0].participants).toBeNull();
    expect(googleMock.members.list).not.toHaveBeenCalled();

    connectionStoreMock.getGoogleConnectionStatus.mockReturnValue(
      connected([SPACES_READONLY, MESSAGES_READONLY, MEMBERSHIPS]),
    );
    googleMock.members.list.mockRejectedValue({ response: { status: 403 } });
    const failed = await request(makeApp()).get('/api/google/chat/spaces');
    expect(failed.status).toBe(200);
    expect(failed.body.spaces[0].participants).toBeNull();
  });

  it('reads every membership page before naming and caching a group chat', async () => {
    connectionStoreMock.getGoogleConnectionStatus.mockReturnValue(
      connected([SPACES_READONLY, MESSAGES_READONLY, MEMBERSHIPS]),
    );
    googleMock.spaces.list.mockResolvedValue({
      data: { spaces: [{ name: 'spaces/G1', spaceType: 'GROUP_CHAT' }] },
    });
    const human = (id: string, displayName: string) => ({
      member: { name: `users/${id}`, displayName, type: 'HUMAN' },
    });
    googleMock.members.list.mockImplementation(async ({ pageToken }: { pageToken?: string }) => ({
      data: pageToken
        ? { memberships: [human('4', 'Priya Nair')] }
        : {
            memberships: [
              human('999', 'Me'),
              human('1', 'Dana'),
              human('2', 'Lee'),
              human('3', 'Sam'),
            ],
            nextPageToken: 'p2',
          },
    }));

    const res = await request(makeApp()).get('/api/google/chat/spaces');

    expect(res.body.spaces[0].participants).toEqual(['Dana', 'Lee', 'Sam', 'Priya Nair']);
    expect(googleMock.members.list).toHaveBeenCalledTimes(2);
    // The continuation keeps every other parameter unchanged.
    expect(googleMock.members.list.mock.calls[1][0]).toEqual({
      parent: 'spaces/G1',
      pageSize: 1000,
      filter: 'member.type = "HUMAN"',
      pageToken: 'p2',
    });

    // Complete, so cached: a second load doesn't re-read members.
    await request(makeApp()).get('/api/google/chat/spaces');
    expect(googleMock.members.list).toHaveBeenCalledTimes(2);
  });
});
