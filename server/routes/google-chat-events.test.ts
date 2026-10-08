import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request } from 'express';
import request from 'supertest';
import type { workspaceevents_v1 } from 'googleapis';
import type { RouteDeps } from '../types.js';

const connectionStoreMock = vi.hoisted(() => ({
  getActiveAccessToken: vi.fn(),
  getGoogleConnectionStatus: vi.fn(),
  getGoogleConnection: vi.fn(),
}));
vi.mock('../google-connections-store.js', () => connectionStoreMock);

const { getDb } = await import('../db.js');
const { default: createGoogleChatEventsRoutes } = await import('./google-chat-events.js');
const { resetChatSubscriptionChecks } = await import('../google-chat-events.js');
const { upsertChatSubscription, recordUnreadMessage, listUnread } =
  await import('../google-chat-events-store.js');

const MESSAGES_READONLY = 'https://www.googleapis.com/auth/chat.messages.readonly';
const CFG = {
  pubsubTopic: 'projects/p/topics/t',
  pushAudience: 'https://hub.example.com/api/google/chat/events/push',
  pushServiceAccountEmail: 'push@p.iam.gserviceaccount.com',
};

const verifier = vi.fn(async (token: string) =>
  token === 'good' ? { email: CFG.pushServiceAccountEmail, email_verified: true } : undefined,
);
const broadcast = vi.fn();
const subscriptions = {
  create: vi.fn(),
  get: vi.fn(),
  patch: vi.fn(),
  list: vi.fn(),
  reactivate: vi.fn(),
  delete: vi.fn(),
};

function makeApp(googleChatEvents: typeof CFG | null = CFG, auth = { authUserId: 'user-1' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req as Request & typeof auth, auth);
    next();
  });
  app.use(
    createGoogleChatEventsRoutes(
      {
        config: { googleOAuth: { clientId: 'cid', clientSecret: 'secret' }, googleChatEvents },
        broadcast,
      } as unknown as RouteDeps,
      {
        verifier,
        eventsDeps: {
          getAccessToken: async () => 'tok',
          eventsClient: () => ({ subscriptions }) as unknown as workspaceevents_v1.Workspaceevents,
        },
      },
    ),
  );
  return app;
}

const envelope = {
  message: {
    attributes: {
      'ce-type': 'google.workspace.chat.message.v1.created',
      'ce-source': '//workspaceevents.googleapis.com/subscriptions/sub-1',
    },
    data: Buffer.from(
      JSON.stringify({
        message: {
          name: 'spaces/S1/messages/m1',
          sender: { name: 'users/9' },
          createTime: '2026-10-08T12:00:00Z',
        },
      }),
    ).toString('base64'),
    messageId: '1',
  },
  subscription: 'projects/p/subscriptions/hub-push',
};

beforeEach(() => {
  getDb().exec(
    'DELETE FROM google_chat_event_subscriptions; DELETE FROM google_chat_unread_messages; DELETE FROM google_chat_space_reads; DELETE FROM google_chat_unread_versions; DELETE FROM google_chat_user_seq; DELETE FROM google_chat_deleted_messages; DELETE FROM google_chat_unrouted_events; DELETE FROM google_chat_subscription_owners;',
  );
  vi.clearAllMocks();
  resetChatSubscriptionChecks();
  connectionStoreMock.getGoogleConnectionStatus.mockReturnValue({
    connected: true,
    grantedScopes: [MESSAGES_READONLY],
  });
  upsertChatSubscription({
    userId: 'user-1',
    subscriptionName: 'subscriptions/sub-1',
    authority: 'users/1',
    state: 'ACTIVE',
    expireTime: new Date(Date.now() + 3 * 3600_000).toISOString(),
  });
});

describe('POST /api/google/chat/events/push', () => {
  it('rejects a push without a valid token', async () => {
    await request(makeApp()).post('/api/google/chat/events/push').send(envelope).expect(401);
    await request(makeApp())
      .post('/api/google/chat/events/push')
      .set('Authorization', 'Bearer forged')
      .send(envelope)
      .expect(401);
    expect(listUnread('user-1')).toEqual([]);
  });

  it('records and fans out a verified push', async () => {
    await request(makeApp())
      .post('/api/google/chat/events/push')
      .set('Authorization', 'Bearer good')
      .send(envelope)
      .expect(204);
    expect(listUnread('user-1')).toHaveLength(1);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'google_chat_message', ownerUserId: 'user-1' }),
    );
  });

  it('acknowledges malformed envelopes so Pub/Sub stops retrying', async () => {
    await request(makeApp())
      .post('/api/google/chat/events/push')
      .set('Authorization', 'Bearer good')
      .send({ nope: true })
      .expect(204);
  });

  it('is 503 when push is not configured', async () => {
    await request(makeApp(null)).post('/api/google/chat/events/push').send(envelope).expect(503);
  });
});

describe('subscription and status', () => {
  it('reports the stored subscription', async () => {
    const res = await request(makeApp()).get('/api/google/chat/events/status').expect(200);
    expect(res.body).toMatchObject({ configured: true, subscription: { state: 'ACTIVE' } });
  });

  it('reports unconfigured without calling Google', async () => {
    const res = await request(makeApp(null))
      .post('/api/google/chat/events/subscription')
      .expect(200);
    expect(res.body).toEqual({ configured: false, subscription: null, version: 1 });
    expect(subscriptions.create).not.toHaveBeenCalled();
  });

  it('checks Google on a subscription call, so a reconnect finds a missed suspension', async () => {
    subscriptions.get.mockResolvedValue({
      data: {
        name: 'subscriptions/sub-1',
        authority: 'users/1',
        state: 'SUSPENDED',
        suspensionReason: 'USER_SCOPE_REVOKED',
        expireTime: new Date(Date.now() + 3 * 3600_000).toISOString(),
        notificationEndpoint: { pubsubTopic: CFG.pubsubTopic },
      },
    });
    subscriptions.reactivate.mockRejectedValue(
      Object.assign(new Error('x'), {
        response: { status: 403, data: { error: { message: 'revoked' } } },
      }),
    );
    await request(makeApp()).post('/api/google/chat/events/subscription');
    const status = await request(makeApp()).get('/api/google/chat/events/status').expect(200);
    expect(status.body.subscription).toMatchObject({ state: 'SUSPENDED' });
  });

  it('requires the Chat read scope', async () => {
    connectionStoreMock.getGoogleConnectionStatus.mockReturnValue({
      connected: true,
      grantedScopes: [],
    });
    const res = await request(makeApp()).post('/api/google/chat/events/subscription').expect(403);
    expect(res.body.code).toBe('google_chat_scope_required');
  });

  it('maps a disabled Workspace Events API to an admin-facing error', async () => {
    getDb().exec('DELETE FROM google_chat_event_subscriptions');
    subscriptions.create.mockRejectedValue(
      Object.assign(new Error('x'), {
        response: {
          status: 403,
          data: {
            error: {
              message:
                'Google Workspace Events API has not been used in project 1 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/workspaceevents.googleapis.com',
            },
          },
        },
      }),
    );
    const res = await request(makeApp()).post('/api/google/chat/events/subscription').expect(403);
    expect(res.body.code).toBe('google_chat_events_api_disabled');
  });
});

describe('unread', () => {
  beforeEach(() => {
    for (const [id, t] of [
      ['a', '2026-10-08T12:00:00Z'],
      ['b', '2026-10-08T12:00:05Z'],
    ]) {
      recordUnreadMessage({
        userId: 'user-1',
        spaceName: 'spaces/S1',
        messageName: `spaces/S1/messages/${id}`,
        createTime: t,
      });
    }
  });

  it('lists unread counts for the caller only', async () => {
    const res = await request(makeApp()).get('/api/google/chat/unread').expect(200);
    expect(res.body).toEqual({
      spaces: [
        { spaceName: 'spaces/S1', count: 2, lastMessageTime: '2026-10-08T12:00:05Z', version: 3 },
      ],
      total: 2,
      version: 3,
    });
    const other = await request(makeApp(CFG, { authUserId: 'user-2' }))
      .get('/api/google/chat/unread')
      .expect(200);
    expect(other.body.total).toBe(0);
  });

  it('marks a space read and tells the user’s other clients', async () => {
    const res = await request(makeApp())
      .post('/api/google/chat/spaces/S1/read')
      .send({ readThrough: '2026-10-08T12:00:00Z' })
      .expect(200);
    expect(res.body).toMatchObject({ spaceName: 'spaces/S1', count: 1 });
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'google_chat_unread', ownerUserId: 'user-1', count: 1 }),
    );
  });

  it('rejects a bad space id or timestamp', async () => {
    await request(makeApp()).post('/api/google/chat/spaces/..%2Fx/read').send({}).expect(400);
    await request(makeApp())
      .post('/api/google/chat/spaces/S1/read')
      .send({ readThrough: 'yesterday' })
      .expect(400);
  });
});
