/**
 * Muting a Google Chat space. Real orgs DB for the mute store; Google and the
 * token store are mocked so nothing leaves the process.
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
const SPACE_SETTINGS = 'https://www.googleapis.com/auth/chat.users.spacesettings';

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
  const spaceNotificationSetting = { patch: vi.fn() };
  return {
    spaceNotificationSetting,
    chat: vi.fn(() => ({ users: { spaces: { spaceNotificationSetting } } })),
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
const createGoogleChatRoutes = (await import('./google-chat.js')).default;

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

function grant(scopes: string[]) {
  connectionStoreMock.getGoogleConnectionStatus.mockReturnValue({
    connected: true,
    grantedScopes: scopes,
  });
}

describe('Google Chat space mutes', () => {
  let owner = '';
  let other = '';

  beforeEach(() => {
    vi.clearAllMocks();
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'google-chat-mutes-route-'));
    setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
    initOrgsDb();
    owner = createUser({ username: 'owner', passwordHash: 'x' }).id;
    other = createUser({ username: 'other', passwordHash: 'x' }).id;
    grant([SPACES_READONLY, MESSAGES_READONLY]);
    connectionStoreMock.getActiveAccessToken.mockResolvedValue('tok');
    googleMock.spaceNotificationSetting.patch.mockResolvedValue({ data: {} });
  });

  it('saves mutes per user and broadcasts the new list to the owner', async () => {
    const broadcast = vi.fn();
    const app = makeApp({ userId: owner }, broadcast);

    const res = await request(app).put('/api/google/chat/spaces/AAA/mute').send({ muted: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      spaceId: 'AAA',
      muted: true,
      spaceIds: ['AAA'],
      revision: 1,
      googleSync: 'not_granted',
    });
    expect(broadcast).toHaveBeenCalledWith({
      type: 'google_chat_mutes',
      ownerUserId: owner,
      spaceIds: ['AAA'],
      revision: 1,
    });
    // Without the spacesettings scope Google is never called.
    expect(googleMock.spaceNotificationSetting.patch).not.toHaveBeenCalled();

    expect((await request(app).get('/api/google/chat/mutes')).body).toEqual({
      spaceIds: ['AAA'],
      revision: 1,
    });
    expect((await request(makeApp({ userId: other })).get('/api/google/chat/mutes')).body).toEqual({
      spaceIds: [],
      revision: 0,
    });

    // Muting twice is idempotent; unmuting removes it.
    await request(app).put('/api/google/chat/spaces/AAA/mute').send({ muted: true });
    const off = await request(app).put('/api/google/chat/spaces/AAA/mute').send({ muted: false });
    expect(off.body.spaceIds).toEqual([]);
    // Every change moves the revision forward, even a repeated mute.
    expect(off.body.revision).toBe(3);
  });

  it('mirrors the mute to Google Chat when the scope is granted', async () => {
    grant([SPACES_READONLY, MESSAGES_READONLY, SPACE_SETTINGS]);
    const app = makeApp({ userId: owner });

    const res = await request(app).put('/api/google/chat/spaces/AAA/mute').send({ muted: true });
    expect(res.body.googleSync).toBe('synced');
    expect(googleMock.spaceNotificationSetting.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'users/me/spaces/AAA/spaceNotificationSetting',
        updateMask: 'muteSetting',
        requestBody: expect.objectContaining({ muteSetting: 'MUTED' }),
      }),
      expect.anything(),
    );

    await request(app).put('/api/google/chat/spaces/AAA/mute').send({ muted: false });
    expect(googleMock.spaceNotificationSetting.patch.mock.calls[1][0].requestBody.muteSetting).toBe(
      'UNMUTED',
    );
  });

  it('leaves Google matching the Hub when a mute and an unmute overlap', async () => {
    grant([SPACES_READONLY, MESSAGES_READONLY, SPACE_SETTINGS]);
    const app = makeApp({ userId: owner });
    // Google answers the first call slowly and the second at once, the order
    // that used to leave Google muted after the Hub was unmuted.
    let releaseFirst!: () => void;
    const google: string[] = [];
    googleMock.spaceNotificationSetting.patch
      .mockImplementationOnce(async (args: any) => {
        await new Promise<void>((r) => (releaseFirst = r));
        google.push(args.requestBody.muteSetting);
        return { data: {} };
      })
      .mockImplementation(async (args: any) => {
        google.push(args.requestBody.muteSetting);
        return { data: {} };
      });

    const mute = request(app).put('/api/google/chat/spaces/AAA/mute').send({ muted: true }).then();
    await vi.waitFor(() =>
      expect(googleMock.spaceNotificationSetting.patch).toHaveBeenCalledTimes(1),
    );
    const unmute = request(app)
      .put('/api/google/chat/spaces/AAA/mute')
      .send({ muted: false })
      .then();
    await new Promise((r) => setTimeout(r, 20));
    // The unmute's mirror waits for the mute's.
    expect(googleMock.spaceNotificationSetting.patch).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([mute, unmute]);

    expect(google).toEqual(['MUTED', 'UNMUTED']);
    expect(google.at(-1)).toBe('UNMUTED');
    expect((await request(app).get('/api/google/chat/mutes')).body.spaceIds).toEqual([]);
  });

  it('keeps the Hub mute when Google refuses the mirror', async () => {
    grant([SPACES_READONLY, MESSAGES_READONLY, SPACE_SETTINGS]);
    googleMock.spaceNotificationSetting.patch.mockRejectedValue(
      Object.assign(new Error('nope'), {
        response: { status: 403, data: { error: { message: 'Permission denied' } } },
      }),
    );
    const app = makeApp({ userId: owner });

    const res = await request(app).put('/api/google/chat/spaces/AAA/mute').send({ muted: true });
    expect(res.status).toBe(200);
    expect(res.body.googleSync).toBe('failed');
    expect(res.body.googleError).toBeTruthy();
    expect((await request(app).get('/api/google/chat/mutes')).body.spaceIds).toEqual(['AAA']);
  });

  it('refuses agent callers and bad input', async () => {
    const agent = await request(makeApp({ userId: owner, spawnSessionId: 'sess-1' }))
      .put('/api/google/chat/spaces/AAA/mute')
      .send({ muted: true });
    expect(agent.status).toBe(403);

    const app = makeApp({ userId: owner });
    expect(
      (await request(app).put('/api/google/chat/spaces/AAA/mute').send({ muted: 'yes' })).status,
    ).toBe(400);
    expect(
      (await request(app).put('/api/google/chat/spaces/a..b/mute').send({ muted: true })).status,
    ).toBe(400);
    expect((await request(app).get('/api/google/chat/mutes')).body.spaceIds).toEqual([]);
  });
});
