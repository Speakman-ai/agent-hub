import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { workspaceevents_v1 } from 'googleapis';
import { getDb } from './db.js';
import {
  CHAT_ALL_SPACES_TARGET,
  CHAT_MESSAGE_BATCH_CREATED,
  CHAT_MESSAGE_CREATED,
  CHAT_MESSAGE_DELETED,
  CHAT_MESSAGE_EVENT_TYPES,
  CHAT_MESSAGE_UPDATED,
  SUBSCRIPTION_EXPIRATION_REMINDER,
  SUBSCRIPTION_EXPIRED,
  SUBSCRIPTION_SUSPENDED,
  ChatEventsAccessLostError,
  ChatEventsNotConfiguredError,
  ChatEventsTokenError,
  ensureChatSubscription,
  handleChatPushEvent,
  resetChatSubscriptionChecks,
  runChatSubscriptionMaintenance,
  verifyPushToken,
  type ChatEventsDeps,
} from './google-chat-events.js';
import {
  getChatSubscription,
  listUnread,
  MAX_UNROUTED_EVENTS,
  bufferUnroutedEvent,
  getSubscriptionOwner,
  getUnreadSnapshot,
  markSpaceRead,
  recordUnreadMessage,
  upsertChatSubscription,
} from './google-chat-events-store.js';
import { resolveGoogleChatEventsConfig } from './google-chat-events-config.js';
import { shouldDeliverBroadcast } from './broadcast-filter.js';

const TOPIC = 'projects/hub-proj/topics/chat-events';
const CFG = {
  pubsubTopic: TOPIC,
  pushAudience: 'https://hub.example.com/api/google/chat/events/push',
  pushServiceAccountEmail: 'pubsub-push@hub-proj.iam.gserviceaccount.com',
};
const NOW = Date.parse('2026-10-08T12:00:00Z');
const inHours = (h: number) => new Date(NOW + h * 3600_000).toISOString();

function remoteSub(over: Partial<workspaceevents_v1.Schema$Subscription> = {}) {
  return {
    name: 'subscriptions/sub-1',
    authority: 'users/111',
    state: 'ACTIVE',
    expireTime: inHours(4),
    targetResource: CHAT_ALL_SPACES_TARGET,
    notificationEndpoint: { pubsubTopic: TOPIC },
    ...over,
  } as workspaceevents_v1.Schema$Subscription;
}

function fakeClient() {
  const subscriptions = {
    create: vi.fn(),
    get: vi.fn(),
    patch: vi.fn(),
    list: vi.fn(),
    reactivate: vi.fn(),
    delete: vi.fn().mockResolvedValue({ data: { done: true } }),
  };
  const operations = { get: vi.fn() };
  return { subscriptions, operations };
}

function googleError(status: number, message = 'err') {
  return Object.assign(new Error(message), { response: { status, data: { error: { message } } } });
}

let client: ReturnType<typeof fakeClient>;
let broadcast: ReturnType<typeof vi.fn<(data: Record<string, unknown>) => void>>;
let deps: ChatEventsDeps;

function push(
  type: string,
  data: unknown,
  source = '//workspaceevents.googleapis.com/subscriptions/sub-1',
) {
  return {
    message: {
      attributes: { 'ce-type': type, 'ce-source': source, 'ce-time': '2026-10-08T12:00:00Z' },
      data: Buffer.from(JSON.stringify(data)).toString('base64'),
    },
  };
}

beforeEach(() => {
  const db = getDb();
  db.exec(
    'DELETE FROM google_chat_event_subscriptions; DELETE FROM google_chat_unread_messages; DELETE FROM google_chat_space_reads; DELETE FROM google_chat_unread_versions; DELETE FROM google_chat_user_seq; DELETE FROM google_chat_deleted_messages; DELETE FROM google_chat_unrouted_events; DELETE FROM google_chat_subscription_owners;',
  );
  resetChatSubscriptionChecks();
  client = fakeClient();
  broadcast = vi.fn<(data: Record<string, unknown>) => void>();
  deps = {
    config: { googleOAuth: { clientId: 'c', clientSecret: 's' }, googleChatEvents: CFG },
    broadcast,
    getAccessToken: vi.fn().mockResolvedValue('tok'),
    hasChatAccess: () => true,
    eventsClient: () => client as unknown as workspaceevents_v1.Workspaceevents,
    now: () => NOW,
    sleep: async () => {},
  };
});

describe('resolveGoogleChatEventsConfig', () => {
  it('derives the push audience from publicUrl', () => {
    expect(
      resolveGoogleChatEventsConfig(
        {
          googleChatEvents: {
            pubsubTopic: TOPIC,
            pushServiceAccountEmail: CFG.pushServiceAccountEmail,
          },
        },
        'https://hub.example.com/',
        {},
      ),
    ).toEqual(CFG);
  });

  it('is null when a piece is missing or the audience is not https', () => {
    expect(
      resolveGoogleChatEventsConfig(
        { googleChatEvents: { pubsubTopic: TOPIC } },
        'https://h.example.com',
        {},
      ),
    ).toBeNull();
    expect(
      resolveGoogleChatEventsConfig(
        {
          googleChatEvents: {
            pubsubTopic: TOPIC,
            pushServiceAccountEmail: CFG.pushServiceAccountEmail,
          },
        },
        'http://h.example.com',
        {},
      ),
    ).toBeNull();
    expect(
      resolveGoogleChatEventsConfig(
        {
          googleChatEvents: {
            pubsubTopic: 'chat-events',
            pushServiceAccountEmail: CFG.pushServiceAccountEmail,
          },
        },
        'https://h.example.com',
        {},
      ),
    ).toBeNull();
  });

  it('prefers env over the file block', () => {
    const cfg = resolveGoogleChatEventsConfig({}, null, {
      AGENT_HUB_GOOGLE_CHAT_PUBSUB_TOPIC: 'projects/p/topics/t',
      AGENT_HUB_GOOGLE_CHAT_PUSH_SERVICE_ACCOUNT: 'sa@p.iam.gserviceaccount.com',
      AGENT_HUB_GOOGLE_CHAT_PUSH_AUDIENCE: 'https://x.example.com/push',
    });
    expect(cfg?.pushAudience).toBe('https://x.example.com/push');
  });
});

describe('ensureChatSubscription', () => {
  it('creates a spaces/- subscription with the resource included and the maximum ttl', async () => {
    client.subscriptions.create.mockResolvedValue({ data: { done: true, response: remoteSub() } });
    const sub = await ensureChatSubscription('u1', deps);
    expect(client.subscriptions.create).toHaveBeenCalledWith({
      requestBody: {
        targetResource: CHAT_ALL_SPACES_TARGET,
        eventTypes: CHAT_MESSAGE_EVENT_TYPES,
        notificationEndpoint: { pubsubTopic: TOPIC },
        payloadOptions: { includeResource: true },
        ttl: '0s',
      },
    });
    expect(sub).toMatchObject({
      subscriptionName: 'subscriptions/sub-1',
      authority: 'users/111',
      state: 'ACTIVE',
      expireTime: inHours(4),
    });
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'google_chat_events_status', ownerUserId: 'u1' }),
    );
  });

  it('makes no Google call while the subscription has time left', async () => {
    upsertChatSubscription({
      userId: 'u1',
      subscriptionName: 'subscriptions/sub-1',
      authority: 'users/111',
      state: 'ACTIVE',
      expireTime: inHours(3),
    });
    await ensureChatSubscription('u1', deps);
    expect(deps.getAccessToken).not.toHaveBeenCalled();
  });

  it('renews with ttl=0s when close to expiry', async () => {
    upsertChatSubscription({
      userId: 'u1',
      subscriptionName: 'subscriptions/sub-1',
      authority: 'users/111',
      state: 'ACTIVE',
      expireTime: inHours(1),
    });
    client.subscriptions.get.mockResolvedValue({ data: remoteSub({ expireTime: inHours(1) }) });
    client.subscriptions.patch.mockResolvedValue({
      data: { done: true, response: remoteSub({ expireTime: inHours(5) }) },
    });
    const sub = await ensureChatSubscription('u1', deps);
    expect(client.subscriptions.patch).toHaveBeenCalledWith({
      name: 'subscriptions/sub-1',
      updateMask: 'ttl',
      requestBody: { ttl: '0s' },
    });
    expect(client.subscriptions.create).not.toHaveBeenCalled();
    expect(sub.expireTime).toBe(inHours(5));
  });

  it('adopts the existing subscription when Google reports a conflict', async () => {
    client.subscriptions.create.mockRejectedValue(googleError(409, 'ALREADY_EXISTS'));
    client.subscriptions.list.mockResolvedValue({
      data: { subscriptions: [remoteSub({ name: 'subscriptions/old' })] },
    });
    const sub = await ensureChatSubscription('u1', deps);
    expect(client.subscriptions.list.mock.calls[0][0].filter).toContain(CHAT_ALL_SPACES_TARGET);
    expect(sub.subscriptionName).toBe('subscriptions/old');
  });

  it('recreates when the stored subscription no longer exists', async () => {
    upsertChatSubscription({
      userId: 'u1',
      subscriptionName: 'subscriptions/gone',
      authority: 'users/111',
      state: 'EXPIRED',
      expireTime: null,
    });
    client.subscriptions.get.mockRejectedValue(googleError(404));
    client.subscriptions.create.mockResolvedValue({ data: { done: true, response: remoteSub() } });
    const sub = await ensureChatSubscription('u1', deps);
    expect(sub.subscriptionName).toBe('subscriptions/sub-1');
  });

  it('reactivates a suspended subscription', async () => {
    upsertChatSubscription({
      userId: 'u1',
      subscriptionName: 'subscriptions/sub-1',
      authority: 'users/111',
      state: 'SUSPENDED',
      expireTime: inHours(3),
    });
    client.subscriptions.get.mockResolvedValue({ data: remoteSub({ state: 'SUSPENDED' }) });
    client.subscriptions.reactivate.mockResolvedValue({
      data: { done: true, response: remoteSub() },
    });
    expect((await ensureChatSubscription('u1', deps)).state).toBe('ACTIVE');
  });

  it('replaces a subscription that publishes to another topic', async () => {
    upsertChatSubscription({
      userId: 'u1',
      subscriptionName: 'subscriptions/old',
      authority: 'users/111',
      state: 'ACTIVE',
      expireTime: inHours(1),
    });
    client.subscriptions.get.mockResolvedValue({
      data: remoteSub({
        name: 'subscriptions/old',
        notificationEndpoint: { pubsubTopic: 'projects/x/topics/y' },
      }),
    });
    client.subscriptions.create.mockResolvedValue({ data: { done: true, response: remoteSub() } });
    const sub = await ensureChatSubscription('u1', deps);
    expect(client.subscriptions.delete).toHaveBeenCalledWith({
      name: 'subscriptions/old',
      allowMissing: true,
    });
    expect(sub.subscriptionName).toBe('subscriptions/sub-1');
  });

  it('records the error and rethrows when Google refuses', async () => {
    client.subscriptions.create.mockRejectedValue(googleError(403, 'Permission denied on topic'));
    await expect(ensureChatSubscription('u1', deps)).rejects.toThrow('Permission denied');
    expect(getChatSubscription('u1')).toMatchObject({
      state: 'ERROR',
      lastError: 'Permission denied on topic',
    });
  });

  it('throws typed errors when unconfigured or the token is gone', async () => {
    await expect(
      ensureChatSubscription('u1', {
        ...deps,
        config: { googleOAuth: null, googleChatEvents: null },
      }),
    ).rejects.toBeInstanceOf(ChatEventsNotConfiguredError);
    await expect(
      ensureChatSubscription('u1', { ...deps, getAccessToken: async () => null }),
    ).rejects.toBeInstanceOf(ChatEventsTokenError);
  });
});

describe('unfinished Workspace Events operations', () => {
  it('polls a pending create until it finishes instead of listing too early', async () => {
    client.subscriptions.create.mockResolvedValue({
      data: { name: 'operations/op-1', done: false },
    });
    client.operations.get
      .mockResolvedValueOnce({ data: { name: 'operations/op-1', done: false } })
      .mockResolvedValueOnce({
        data: { name: 'operations/op-1', done: true, response: remoteSub() },
      });
    const sub = await ensureChatSubscription('u1', deps);
    expect(client.operations.get).toHaveBeenCalledWith({ name: 'operations/op-1' });
    expect(client.subscriptions.list).not.toHaveBeenCalled();
    expect(sub).toMatchObject({ state: 'ACTIVE', subscriptionName: 'subscriptions/sub-1' });
  });

  it('saves the renewed state, not the pre-renewal read', async () => {
    upsertChatSubscription({
      userId: 'u1',
      subscriptionName: 'subscriptions/sub-1',
      authority: 'users/111',
      state: 'ACTIVE',
      expireTime: inHours(1),
    });
    client.subscriptions.get.mockResolvedValue({ data: remoteSub({ expireTime: inHours(1) }) });
    client.subscriptions.patch.mockResolvedValue({
      data: { name: 'operations/op-2', done: false },
    });
    client.operations.get.mockResolvedValue({
      data: {
        name: 'operations/op-2',
        done: true,
        response: remoteSub({ expireTime: inHours(5) }),
      },
    });
    expect((await ensureChatSubscription('u1', deps)).expireTime).toBe(inHours(5));
  });

  it('surfaces an operation that finishes with an error', async () => {
    client.subscriptions.create.mockResolvedValue({
      data: { name: 'operations/op-3', done: false },
    });
    client.operations.get.mockResolvedValue({
      data: { name: 'operations/op-3', done: true, error: { message: 'INVALID_PUBSUB_TOPIC' } },
    });
    await expect(ensureChatSubscription('u1', deps)).rejects.toThrow('INVALID_PUBSUB_TOPIC');
    expect(getChatSubscription('u1')).toMatchObject({
      state: 'ERROR',
      lastError: 'INVALID_PUBSUB_TOPIC',
    });
  });

  it('gives up on an operation that never finishes, and the next tick retries', async () => {
    client.subscriptions.create.mockResolvedValue({
      data: { name: 'operations/op-4', done: false },
    });
    client.operations.get.mockResolvedValue({ data: { name: 'operations/op-4', done: false } });
    await expect(ensureChatSubscription('u1', deps)).rejects.toThrow('still running');
    expect(getChatSubscription('u1')?.state).toBe('ERROR');

    // The create landed after all: the retry hits a conflict and adopts it.
    client.subscriptions.create.mockRejectedValue(googleError(409, 'ALREADY_EXISTS'));
    client.subscriptions.list.mockResolvedValue({ data: { subscriptions: [remoteSub()] } });
    await runChatSubscriptionMaintenance(deps);
    expect(getChatSubscription('u1')).toMatchObject({
      state: 'ACTIVE',
      subscriptionName: 'subscriptions/sub-1',
    });
  });
});

describe('replacing a subscription waits for the delete', () => {
  const wrongTopic = (name: string) =>
    remoteSub({ name, notificationEndpoint: { pubsubTopic: 'projects/x/topics/old' } });

  it('creates the replacement only after a pending delete finishes', async () => {
    upsertChatSubscription({
      userId: 'u1',
      subscriptionName: 'subscriptions/old',
      authority: 'users/111',
      state: 'ACTIVE',
      expireTime: inHours(1),
    });
    client.subscriptions.get.mockResolvedValue({ data: wrongTopic('subscriptions/old') });
    client.subscriptions.delete.mockResolvedValue({
      data: { name: 'operations/del-1', done: false },
    });
    client.operations.get.mockResolvedValue({ data: { name: 'operations/del-1', done: true } });
    client.subscriptions.create.mockResolvedValue({ data: { done: true, response: remoteSub() } });

    const sub = await ensureChatSubscription('u1', deps);
    expect(sub.subscriptionName).toBe('subscriptions/sub-1');
    expect(client.operations.get).toHaveBeenCalledWith({ name: 'operations/del-1' });
    expect(client.operations.get.mock.invocationCallOrder[0]).toBeLessThan(
      client.subscriptions.create.mock.invocationCallOrder[0],
    );
  });

  it('replaces a conflicting subscription found on create, then creates once more', async () => {
    client.subscriptions.create
      .mockRejectedValueOnce(googleError(409, 'ALREADY_EXISTS'))
      .mockResolvedValueOnce({ data: { done: true, response: remoteSub() } });
    client.subscriptions.list.mockResolvedValue({
      data: { subscriptions: [wrongTopic('subscriptions/old')] },
    });
    client.subscriptions.delete.mockResolvedValue({
      data: { name: 'operations/del-2', done: false },
    });
    client.operations.get.mockResolvedValue({ data: { name: 'operations/del-2', done: true } });

    const sub = await ensureChatSubscription('u1', deps);
    expect(client.subscriptions.delete).toHaveBeenCalledWith({
      name: 'subscriptions/old',
      allowMissing: true,
    });
    expect(client.subscriptions.create).toHaveBeenCalledTimes(2);
    expect(sub).toMatchObject({ state: 'ACTIVE', subscriptionName: 'subscriptions/sub-1' });
  });

  it('gives up on a second conflict instead of looping', async () => {
    client.subscriptions.create.mockRejectedValue(googleError(409, 'ALREADY_EXISTS'));
    client.subscriptions.list.mockResolvedValue({
      data: { subscriptions: [wrongTopic('subscriptions/old')] },
    });
    await expect(ensureChatSubscription('u1', deps)).rejects.toThrow('ALREADY_EXISTS');
    expect(client.subscriptions.create).toHaveBeenCalledTimes(2);
  });
});

describe('the stored row follows Google, not the other way round', () => {
  beforeEach(() => {
    resetChatSubscriptionChecks();
    upsertChatSubscription({
      userId: 'u1',
      subscriptionName: 'subscriptions/sub-1',
      authority: 'users/111',
      state: 'ACTIVE',
      expireTime: inHours(3),
    });
  });

  it('finds a suspension whose event never arrived when asked to verify', async () => {
    client.subscriptions.get.mockResolvedValue({
      data: remoteSub({ state: 'SUSPENDED', suspensionReason: 'USER_SCOPE_REVOKED' }),
    });
    client.subscriptions.reactivate.mockRejectedValue(googleError(403, 'scope revoked'));
    await expect(ensureChatSubscription('u1', deps, { verify: true })).rejects.toThrow();
    // Google's answer stands even though reactivating failed.
    expect(getChatSubscription('u1')).toMatchObject({
      state: 'SUSPENDED',
      suspensionReason: 'USER_SCOPE_REVOKED',
      expireTime: inHours(4),
      lastError: 'scope revoked',
    });
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'google_chat_events_status',
        subscription: expect.objectContaining({ state: 'SUSPENDED' }),
      }),
    );
  });

  it('finds it from the maintenance loop too, before the renewal window', async () => {
    client.subscriptions.get.mockResolvedValue({ data: remoteSub({ state: 'SUSPENDED' }) });
    client.subscriptions.reactivate.mockRejectedValue(googleError(403, 'scope revoked'));
    await runChatSubscriptionMaintenance(deps);
    expect(getChatSubscription('u1')?.state).toBe('SUSPENDED');
  });

  it('reads Google at most once per interval when verify has a max age', async () => {
    client.subscriptions.get.mockResolvedValue({ data: remoteSub() });
    await ensureChatSubscription('u1', deps, { verify: { maxAgeMs: 60_000 } });
    await ensureChatSubscription('u1', deps, { verify: { maxAgeMs: 60_000 } });
    expect(client.subscriptions.get).toHaveBeenCalledTimes(1);
    await ensureChatSubscription(
      'u1',
      { ...deps, now: () => NOW + 61_000 },
      {
        verify: { maxAgeMs: 60_000 },
      },
    );
    expect(client.subscriptions.get).toHaveBeenCalledTimes(2);
  });

  it('keeps the real expiry when a reminder-triggered renewal fails', async () => {
    client.subscriptions.get.mockRejectedValue(googleError(500, 'backend error'));
    const result = handleChatPushEvent(
      push(SUBSCRIPTION_EXPIRATION_REMINDER, { subscription: remoteSub() }),
      deps,
    );
    await result.followUp;
    expect(getChatSubscription('u1')).toMatchObject({
      state: 'ACTIVE',
      expireTime: inHours(3),
      lastError: 'backend error',
    });
    const statuses = broadcast.mock.calls
      .map(([e]) => e)
      .filter((e) => e.type === 'google_chat_events_status');
    for (const e of statuses) {
      expect((e.subscription as { expireTime: string | null }).expireTime).toBe(inHours(3));
    }
  });

  it('renews on a reminder even when expiry is not near yet', async () => {
    client.subscriptions.get.mockResolvedValue({ data: remoteSub({ expireTime: inHours(3) }) });
    client.subscriptions.patch.mockResolvedValue({
      data: { done: true, response: remoteSub({ expireTime: inHours(4) }) },
    });
    const result = handleChatPushEvent(
      push(SUBSCRIPTION_EXPIRATION_REMINDER, { subscription: remoteSub() }),
      deps,
    );
    await result.followUp;
    expect(client.subscriptions.patch).toHaveBeenCalledTimes(1);
    expect(getChatSubscription('u1')?.expireTime).toBe(inHours(4));
  });
});

describe('deliveries that race subscription creation', () => {
  const msg = {
    name: 'spaces/S1/messages/early',
    sender: { name: 'users/222' },
    createTime: '2026-10-08T12:00:00Z',
  };

  it('holds a delivery that lands before the create finishes, then applies it', async () => {
    client.subscriptions.create.mockResolvedValue({
      data: { name: 'operations/op-1', done: false },
    });
    client.operations.get.mockImplementation(async () => {
      // Google is already delivering for the new subscription.
      const early = handleChatPushEvent(push(CHAT_MESSAGE_CREATED, { message: msg }), deps);
      expect(early.ignored).toBe('unknown_subscription');
      return { data: { name: 'operations/op-1', done: true, response: remoteSub() } };
    });

    await ensureChatSubscription('u1', deps);
    expect(listUnread('u1')).toMatchObject([{ spaceName: 'spaces/S1', count: 1 }]);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'google_chat_message',
        ownerUserId: 'u1',
        messageName: 'spaces/S1/messages/early',
      }),
    );
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM google_chat_unrouted_events').get()).toEqual({
      n: 0,
    });
  });

  it('keeps a held delivery whose replay fails, and applies it on the next pass', async () => {
    const db = getDb();
    client.subscriptions.create.mockResolvedValue({
      data: { name: 'operations/op-1', done: false },
    });
    client.operations.get.mockImplementation(async () => {
      handleChatPushEvent(push(CHAT_MESSAGE_CREATED, { message: msg }), deps);
      // The database fails while the held delivery is being applied.
      db.exec(`CREATE TEMP TRIGGER fail_unread BEFORE INSERT ON google_chat_unread_messages
               BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;`);
      return { data: { name: 'operations/op-1', done: true, response: remoteSub() } };
    });
    try {
      await ensureChatSubscription('u1', deps);
    } finally {
      db.exec('DROP TRIGGER IF EXISTS fail_unread');
    }
    expect(listUnread('u1')).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM google_chat_unrouted_events').get()).toEqual({
      n: 1,
    });
    expect(broadcast.mock.calls.some(([e]) => e.type === 'google_chat_message')).toBe(false);

    // The maintenance loop reads Google every tick, which saves and replays.
    client.subscriptions.get.mockResolvedValue({ data: remoteSub() });
    await runChatSubscriptionMaintenance(deps);
    expect(listUnread('u1')).toMatchObject([{ spaceName: 'spaces/S1', count: 1 }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM google_chat_unrouted_events').get()).toEqual({
      n: 0,
    });
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'google_chat_message',
        messageName: 'spaces/S1/messages/early',
      }),
    );
  });

  it('drops held deliveries nobody claims within an hour', async () => {
    handleChatPushEvent(
      push(
        CHAT_MESSAGE_CREATED,
        { message: msg },
        '//workspaceevents.googleapis.com/subscriptions/stranger',
      ),
      deps,
    );
    await runChatSubscriptionMaintenance({ ...deps, now: () => Date.now() + 30 * 60_000 });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM google_chat_unrouted_events').get()).toEqual({
      n: 1,
    });
    await runChatSubscriptionMaintenance({ ...deps, now: () => Date.now() + 61 * 60_000 });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM google_chat_unrouted_events').get()).toEqual({
      n: 0,
    });
  });

  it('caps what it holds', () => {
    for (let i = 0; i < MAX_UNROUTED_EVENTS + 3; i++) bufferUnroutedEvent('subscriptions/x', '{}');
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM google_chat_unrouted_events').get()).toEqual({
      n: MAX_UNROUTED_EVENTS,
    });
  });
});

describe('viewed before its event arrives', () => {
  it('a read marker set with nothing unread keeps the late created event from counting', () => {
    upsertChatSubscription({
      userId: 'u1',
      subscriptionName: 'subscriptions/sub-1',
      authority: 'users/111',
      state: 'ACTIVE',
      expireTime: inHours(3),
    });
    // The pane showed the message (loaded over HTTP) and recorded it as seen.
    markSpaceRead({ userId: 'u1', spaceName: 'spaces/S1', readThrough: '2026-10-08T12:00:00Z' });
    const result = handleChatPushEvent(
      push(CHAT_MESSAGE_CREATED, {
        message: {
          name: 'spaces/S1/messages/seen',
          sender: { name: 'users/222' },
          createTime: '2026-10-08T12:00:00Z',
        },
      }),
      deps,
    );
    expect(result.recorded).toEqual([]);
    expect(listUnread('u1')).toEqual([]);
  });
});

describe('late deliveries from retired subscriptions', () => {
  const OLD = '//workspaceevents.googleapis.com/subscriptions/sub-1';
  const late = {
    name: 'spaces/S1/messages/late',
    sender: { name: 'users/222' },
    createTime: '2026-10-08T11:59:59Z',
  };

  beforeEach(() => {
    upsertChatSubscription({
      userId: 'u1',
      subscriptionName: 'subscriptions/sub-1',
      authority: 'users/111',
      state: 'ACTIVE',
      expireTime: inHours(3),
    });
  });

  it('routes a message from the old subscription after expiry and recreation', async () => {
    client.subscriptions.get.mockRejectedValue(googleError(404, 'not found'));
    client.subscriptions.create.mockResolvedValue({
      data: { done: true, response: remoteSub({ name: 'subscriptions/sub-2' }) },
    });
    await handleChatPushEvent(push(SUBSCRIPTION_EXPIRED, { subscription: remoteSub() }), deps)
      .followUp;
    expect(getChatSubscription('u1')?.subscriptionName).toBe('subscriptions/sub-2');

    const result = handleChatPushEvent(push(CHAT_MESSAGE_CREATED, { message: late }, OLD), deps);
    expect(result).toMatchObject({ userId: 'u1', recorded: ['spaces/S1/messages/late'] });
    expect(listUnread('u1')).toMatchObject([{ spaceName: 'spaces/S1', count: 1 }]);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'google_chat_message',
        messageName: 'spaces/S1/messages/late',
      }),
    );
  });

  it('routes a message from a subscription that was replaced', () => {
    upsertChatSubscription({
      userId: 'u1',
      subscriptionName: 'subscriptions/sub-2',
      authority: 'users/111',
      state: 'ACTIVE',
      expireTime: inHours(4),
    });
    const result = handleChatPushEvent(push(CHAT_MESSAGE_CREATED, { message: late }, OLD), deps);
    expect(result.recorded).toEqual(['spaces/S1/messages/late']);
  });

  it('ignores lifecycle events from a retired subscription', () => {
    upsertChatSubscription({
      userId: 'u1',
      subscriptionName: 'subscriptions/sub-2',
      authority: 'users/111',
      state: 'ACTIVE',
      expireTime: inHours(4),
    });
    const result = handleChatPushEvent(
      push(SUBSCRIPTION_SUSPENDED, { subscription: { suspensionReason: 'OTHER' } }, OLD),
      deps,
    );
    expect(result.ignored).toBe('retired_subscription');
    expect(getChatSubscription('u1')).toMatchObject({
      subscriptionName: 'subscriptions/sub-2',
      state: 'ACTIVE',
    });
  });

  it('stops routing old names once access is lost', async () => {
    upsertChatSubscription({
      userId: 'u1',
      subscriptionName: 'subscriptions/sub-2',
      authority: 'users/111',
      state: 'ACTIVE',
      expireTime: inHours(4),
    });
    await runChatSubscriptionMaintenance({ ...deps, hasChatAccess: () => false });
    const result = handleChatPushEvent(push(CHAT_MESSAGE_CREATED, { message: late }, OLD), deps);
    expect(result.ignored).toBe('unknown_subscription');
    expect(listUnread('u1')).toEqual([]);
  });

  it('forgets retired names after the redelivery window', async () => {
    upsertChatSubscription({
      userId: 'u1',
      subscriptionName: 'subscriptions/sub-2',
      authority: 'users/111',
      state: 'ACTIVE',
      expireTime: inHours(4),
    });
    client.subscriptions.get.mockResolvedValue({
      data: remoteSub({ name: 'subscriptions/sub-2', expireTime: inHours(4) }),
    });
    await runChatSubscriptionMaintenance({ ...deps, now: () => Date.now() + 7 * 24 * 3600_000 });
    expect(
      handleChatPushEvent(push(CHAT_MESSAGE_CREATED, { message: late }, OLD), deps).userId,
    ).toBe('u1');
    await runChatSubscriptionMaintenance({ ...deps, now: () => Date.now() + 9 * 24 * 3600_000 });
    expect(
      handleChatPushEvent(
        push(CHAT_MESSAGE_CREATED, { message: { ...late, name: 'spaces/S1/messages/later' } }, OLD),
        deps,
      ).ignored,
    ).toBe('unknown_subscription');
  });
});

describe('access loss while a check is waiting on Google', () => {
  it('keeps the subscription and its ownership cleared when the pending check resolves', async () => {
    upsertChatSubscription({
      userId: 'u1',
      subscriptionName: 'subscriptions/sub-1',
      authority: 'users/111',
      state: 'ACTIVE',
      expireTime: inHours(3),
    });
    let access = true;
    const accessDeps = { ...deps, hasChatAccess: () => access };
    let resolveGet!: (v: unknown) => void;
    client.subscriptions.get.mockReturnValue(new Promise((r) => (resolveGet = r)));

    const pending = ensureChatSubscription('u1', accessDeps, { verify: true });
    await vi.waitFor(() => expect(client.subscriptions.get).toHaveBeenCalled());

    access = false;
    const cleanup = runChatSubscriptionMaintenance(accessDeps);
    resolveGet({ data: remoteSub() });
    await expect(pending).rejects.toBeInstanceOf(ChatEventsAccessLostError);
    await cleanup;

    expect(getChatSubscription('u1')).toBeNull();
    expect(getSubscriptionOwner('subscriptions/sub-1')).toBeNull();
    // Nothing reported the subscription as alive after cleanup.
    const statuses = broadcast.mock.calls
      .map(([e]) => e)
      .filter((e) => e.type === 'google_chat_events_status');
    expect(statuses.at(-1)?.subscription).toBeNull();
    // Deliveries for it no longer reach the user.
    const late = handleChatPushEvent(
      push(CHAT_MESSAGE_CREATED, {
        message: {
          name: 'spaces/S1/messages/x',
          sender: { name: 'users/2' },
          createTime: '2026-10-08T12:00:00Z',
        },
      }),
      accessDeps,
    );
    expect(late.ignored).toBe('unknown_subscription');
    expect(listUnread('u1')).toEqual([]);
  });

  it('does not call Google for a user without access', async () => {
    await expect(
      ensureChatSubscription('u1', { ...deps, hasChatAccess: () => false }),
    ).rejects.toBeInstanceOf(ChatEventsAccessLostError);
    expect(client.subscriptions.create).not.toHaveBeenCalled();
    expect(getChatSubscription('u1')).toBeNull();
  });
});

describe('runChatSubscriptionMaintenance', () => {
  it('renews subscriptions near expiry and leaves fresh ones alone', async () => {
    upsertChatSubscription({
      userId: 'near',
      subscriptionName: 'subscriptions/a',
      authority: null,
      state: 'ACTIVE',
      expireTime: inHours(1),
    });
    upsertChatSubscription({
      userId: 'fresh',
      subscriptionName: 'subscriptions/b',
      authority: null,
      state: 'ACTIVE',
      expireTime: inHours(3.5),
    });
    client.subscriptions.get.mockImplementation(async ({ name }: { name: string }) => ({
      data: remoteSub({
        name,
        authority: null,
        expireTime: name === 'subscriptions/a' ? inHours(1) : inHours(3.5),
      }),
    }));
    client.subscriptions.patch.mockResolvedValue({
      data: {
        done: true,
        response: remoteSub({ name: 'subscriptions/a', expireTime: inHours(5) }),
      },
    });
    await runChatSubscriptionMaintenance(deps);
    // Both are read from Google; only the one near expiry is renewed.
    expect(client.subscriptions.get).toHaveBeenCalledTimes(2);
    expect(client.subscriptions.patch).toHaveBeenCalledTimes(1);
    expect(getChatSubscription('near')?.expireTime).toBe(inHours(5));
    expect(getChatSubscription('fresh')?.expireTime).toBe(inHours(3.5));
  });

  it('clears state for users who lost Chat access', async () => {
    upsertChatSubscription({
      userId: 'gone',
      subscriptionName: 'subscriptions/a',
      authority: null,
      state: 'ACTIVE',
      expireTime: inHours(1),
    });
    recordUnreadMessage({
      userId: 'gone',
      spaceName: 'spaces/S',
      messageName: 'spaces/S/messages/m',
      createTime: inHours(0),
    });
    const before = getUnreadSnapshot('gone').version;
    await runChatSubscriptionMaintenance({ ...deps, hasChatAccess: () => false });
    // Connected clients drop the badge: a newer zero-count update per space.
    const unreadEvent = broadcast.mock.calls
      .map(([e]) => e)
      .find((e) => e.type === 'google_chat_unread' && e.ownerUserId === 'gone');
    expect(unreadEvent).toMatchObject({ spaceName: 'spaces/S', count: 0 });
    expect(unreadEvent?.version as number).toBeGreaterThan(before);
    expect(getChatSubscription('gone')).toBeNull();
    expect(listUnread('gone')).toEqual([]);
    expect(client.subscriptions.patch).not.toHaveBeenCalled();
  });
});

describe('handleChatPushEvent', () => {
  beforeEach(() => {
    upsertChatSubscription({
      userId: 'u1',
      subscriptionName: 'subscriptions/sub-1',
      authority: 'users/111',
      state: 'ACTIVE',
      expireTime: inHours(3),
    });
  });

  const message = (id: string, over: Record<string, unknown> = {}) => ({
    name: `spaces/S1/messages/${id}`,
    sender: { name: 'users/222', type: 'HUMAN' },
    createTime: '2026-10-08T12:00:00.123456Z',
    text: 'customer says hi',
    thread: { name: 'spaces/S1/threads/t1' },
    space: { name: 'spaces/S1' },
    ...over,
  });

  it('records an unread message and broadcasts names only to the owner', () => {
    const result = handleChatPushEvent(
      push(CHAT_MESSAGE_CREATED, { message: message('m1') }),
      deps,
    );
    expect(result).toMatchObject({ userId: 'u1', recorded: ['spaces/S1/messages/m1'] });
    expect(listUnread('u1')).toEqual([
      {
        spaceName: 'spaces/S1',
        count: 1,
        lastMessageTime: '2026-10-08T12:00:00.123456Z',
        version: 2,
      },
    ]);
    const event = broadcast.mock.calls[0][0];
    expect(event).toMatchObject({
      type: 'google_chat_message',
      ownerUserId: 'u1',
      spaceName: 'spaces/S1',
      messageName: 'spaces/S1/messages/m1',
      threadName: 'spaces/S1/threads/t1',
      own: false,
      unread: { count: 1 },
    });
    expect(JSON.stringify(event)).not.toContain('customer says hi');
  });

  it('counts a redelivered message once', () => {
    const env = push(CHAT_MESSAGE_CREATED, { message: message('m1') });
    handleChatPushEvent(env, deps);
    expect(handleChatPushEvent(env, deps).recorded).toEqual([]);
    expect(listUnread('u1')[0].count).toBe(1);
  });

  it("does not count the user's own messages but still signals the space changed", () => {
    const result = handleChatPushEvent(
      push(CHAT_MESSAGE_CREATED, { message: message('m1', { sender: { name: 'users/111' } }) }),
      deps,
    );
    expect(result.recorded).toEqual([]);
    expect(listUnread('u1')).toEqual([]);
    expect(broadcast.mock.calls[0][0]).toMatchObject({ own: true, unread: { count: 0 } });
  });

  it('handles batched message events', () => {
    const result = handleChatPushEvent(
      push(CHAT_MESSAGE_BATCH_CREATED, {
        messages: [
          { message: message('a') },
          { message: message('b', { createTime: '2026-10-08T12:00:01Z' }) },
        ],
      }),
      deps,
    );
    expect(result.recorded).toHaveLength(2);
    expect(listUnread('u1')[0]).toMatchObject({
      count: 2,
      lastMessageTime: '2026-10-08T12:00:01Z',
    });
  });

  it('ignores events for subscriptions the Hub does not know', () => {
    const result = handleChatPushEvent(
      push(
        CHAT_MESSAGE_CREATED,
        { message: message('m1') },
        '//workspaceevents.googleapis.com/subscriptions/other',
      ),
      deps,
    );
    expect(result.ignored).toBe('unknown_subscription');
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('drops malformed envelopes', () => {
    expect(handleChatPushEvent({ message: {} }, deps).ignored).toBe('malformed');
    expect(
      handleChatPushEvent(
        {
          message: {
            attributes: {
              'ce-type': CHAT_MESSAGE_CREATED,
              'ce-source': '//workspaceevents.googleapis.com/subscriptions/sub-1',
            },
            data: '!!notjson',
          },
        },
        deps,
      ).ignored,
    ).toBe('malformed');
  });

  it('renews on an expiration reminder', async () => {
    client.subscriptions.get.mockResolvedValue({ data: remoteSub({ expireTime: inHours(1) }) });
    client.subscriptions.patch.mockResolvedValue({
      data: { done: true, response: remoteSub({ expireTime: inHours(5) }) },
    });
    const result = handleChatPushEvent(
      push(SUBSCRIPTION_EXPIRATION_REMINDER, { subscription: remoteSub() }),
      deps,
    );
    await result.followUp;
    expect(client.subscriptions.patch).toHaveBeenCalled();
    expect(getChatSubscription('u1')?.expireTime).toBe(inHours(5));
  });

  it('records a suspension Google confirms, with its reason', async () => {
    client.subscriptions.get.mockResolvedValue({
      data: remoteSub({ state: 'SUSPENDED', suspensionReason: 'USER_SCOPE_REVOKED' }),
    });
    client.subscriptions.reactivate.mockRejectedValue(googleError(403, 'scope revoked'));
    await handleChatPushEvent(
      push(SUBSCRIPTION_SUSPENDED, { subscription: { suspensionReason: 'USER_SCOPE_REVOKED' } }),
      deps,
    ).followUp;
    expect(getChatSubscription('u1')).toMatchObject({
      state: 'SUSPENDED',
      suspensionReason: 'USER_SCOPE_REVOKED',
    });
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'google_chat_events_status', ownerUserId: 'u1' }),
    );
  });

  it('ignores a suspension delivered after the subscription was reactivated', async () => {
    // Google already reactivated it; the old notification arrives late.
    client.subscriptions.get.mockResolvedValue({ data: remoteSub({ state: 'ACTIVE' }) });
    const statusBefore = broadcast.mock.calls.length;
    await handleChatPushEvent(
      push(SUBSCRIPTION_SUSPENDED, { subscription: { suspensionReason: 'USER_SCOPE_REVOKED' } }),
      deps,
    ).followUp;
    expect(getChatSubscription('u1')).toMatchObject({ state: 'ACTIVE', suspensionReason: null });
    expect(
      broadcast.mock.calls
        .slice(statusBefore)
        .some(([e]) => (e.subscription as { state?: string } | null)?.state === 'SUSPENDED'),
    ).toBe(false);
    // Maintenance keeps verifying it rather than backing off for an hour.
    client.subscriptions.get.mockClear();
    await runChatSubscriptionMaintenance(deps);
    expect(client.subscriptions.get).toHaveBeenCalledTimes(1);
  });

  it('ignores an expiry delivered after the subscription was renewed', async () => {
    client.subscriptions.get.mockResolvedValue({ data: remoteSub({ expireTime: inHours(4) }) });
    await handleChatPushEvent(push(SUBSCRIPTION_EXPIRED, { subscription: remoteSub() }), deps)
      .followUp;
    expect(client.subscriptions.create).not.toHaveBeenCalled();
    expect(getChatSubscription('u1')).toMatchObject({
      state: 'ACTIVE',
      subscriptionName: 'subscriptions/sub-1',
    });
  });

  it('runs one reconcile per user at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    client.subscriptions.get.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { data: remoteSub() };
    });
    await Promise.all([
      ensureChatSubscription('u1', deps, { verify: true }),
      ensureChatSubscription('u1', deps, { verify: true }),
      handleChatPushEvent(push(SUBSCRIPTION_SUSPENDED, { subscription: {} }), deps).followUp,
    ]);
    expect(client.subscriptions.get).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1);
  });

  it('recreates the subscription when Google confirms it expired', async () => {
    client.subscriptions.get.mockRejectedValue(googleError(404, 'not found'));
    client.subscriptions.create.mockResolvedValue({
      data: { done: true, response: remoteSub({ name: 'subscriptions/sub-2' }) },
    });
    const result = handleChatPushEvent(
      push(SUBSCRIPTION_EXPIRED, { subscription: remoteSub() }),
      deps,
    );
    await result.followUp;
    expect(getChatSubscription('u1')).toMatchObject({
      state: 'ACTIVE',
      subscriptionName: 'subscriptions/sub-2',
    });
  });
});

describe('edits, deletions, and subscription event types', () => {
  beforeEach(() => {
    upsertChatSubscription({
      userId: 'u1',
      subscriptionName: 'subscriptions/sub-1',
      authority: 'users/111',
      state: 'ACTIVE',
      expireTime: inHours(3),
    });
  });

  const created = (id: string) => ({
    name: `spaces/S1/messages/${id}`,
    sender: { name: 'users/222' },
    createTime: '2026-10-08T12:00:00Z',
  });

  it('signals an edit so the open pane re-reads, without touching unread', () => {
    handleChatPushEvent(push(CHAT_MESSAGE_CREATED, { message: created('m1') }), deps);
    broadcast.mockClear();
    handleChatPushEvent(
      push(CHAT_MESSAGE_UPDATED, {
        message: { ...created('m1'), lastUpdateTime: '2026-10-08T12:05:00Z' },
      }),
      deps,
    );
    expect(broadcast.mock.calls[0][0]).toMatchObject({
      type: 'google_chat_message',
      kind: 'updated',
      spaceName: 'spaces/S1',
      unread: { count: 1, version: 2 },
    });
  });

  it('keeps a deleted message from coming back when its created event arrives later', () => {
    handleChatPushEvent(
      push(CHAT_MESSAGE_DELETED, { message: { name: 'spaces/S1/messages/m1' } }),
      deps,
    );
    const result = handleChatPushEvent(
      push(CHAT_MESSAGE_CREATED, { message: created('m1') }),
      deps,
    );
    expect(result.recorded).toEqual([]);
    expect(listUnread('u1')).toEqual([]);
  });

  it('keeps a deleted message from coming back when its created event is redelivered', () => {
    const create = push(CHAT_MESSAGE_CREATED, { message: created('m1') });
    handleChatPushEvent(create, deps);
    handleChatPushEvent(
      push(CHAT_MESSAGE_DELETED, { message: { name: 'spaces/S1/messages/m1' } }),
      deps,
    );
    handleChatPushEvent(create, deps);
    expect(listUnread('u1')).toEqual([]);
  });

  it('prunes deletion markers past the redelivery window', async () => {
    handleChatPushEvent(
      push(CHAT_MESSAGE_DELETED, { message: { name: 'spaces/S1/messages/m1' } }),
      deps,
    );
    await runChatSubscriptionMaintenance({ ...deps, now: () => Date.now() + 7 * 24 * 3600_000 });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM google_chat_deleted_messages').get()).toEqual(
      { n: 1 },
    );
    await runChatSubscriptionMaintenance({ ...deps, now: () => Date.now() + 9 * 24 * 3600_000 });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM google_chat_deleted_messages').get()).toEqual(
      { n: 0 },
    );
  });

  it('drops a deleted message from unread under a new version, batch variant included', () => {
    handleChatPushEvent(push(CHAT_MESSAGE_CREATED, { message: created('m1') }), deps);
    handleChatPushEvent(
      push('google.workspace.chat.message.v1.batchDeleted', {
        messages: [{ message: { name: 'spaces/S1/messages/m1' } }],
      }),
      deps,
    );
    expect(listUnread('u1')).toEqual([]);
    expect(broadcast.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'deleted',
      unread: { count: 0, version: 3 },
    });
  });

  it('replaces a subscription created without edit and delete events', async () => {
    upsertChatSubscription({
      userId: 'u1',
      subscriptionName: 'subscriptions/old',
      authority: 'users/111',
      state: 'ACTIVE',
      expireTime: inHours(1),
    });
    client.subscriptions.get.mockResolvedValue({
      data: remoteSub({ name: 'subscriptions/old', eventTypes: [CHAT_MESSAGE_CREATED] }),
    });
    client.subscriptions.create.mockResolvedValue({
      data: { done: true, response: remoteSub({ eventTypes: CHAT_MESSAGE_EVENT_TYPES }) },
    });
    const sub = await ensureChatSubscription('u1', deps);
    expect(client.subscriptions.delete).toHaveBeenCalledWith({
      name: 'subscriptions/old',
      allowMissing: true,
    });
    expect(sub.subscriptionName).toBe('subscriptions/sub-1');
    expect(client.subscriptions.create.mock.calls[0][0].requestBody.eventTypes).toContain(
      CHAT_MESSAGE_DELETED,
    );
  });
});

describe('status versions', () => {
  it('orders status events after the reads that preceded them', async () => {
    client.subscriptions.get.mockResolvedValue({ data: remoteSub({ state: 'SUSPENDED' }) });
    client.subscriptions.reactivate.mockRejectedValue(googleError(403, 'scope revoked'));
    const before = upsertChatSubscription({
      userId: 'u1',
      subscriptionName: 'subscriptions/sub-1',
      authority: 'users/111',
      state: 'ACTIVE',
      expireTime: inHours(3),
    }).version;
    expect(getChatSubscription('u1')?.version).toBe(before);
    await handleChatPushEvent(
      push(SUBSCRIPTION_SUSPENDED, { subscription: { suspensionReason: 'USER_SCOPE_REVOKED' } }),
      deps,
    ).followUp;
    const event = broadcast.mock.calls
      .map(([e]) => e)
      .find(
        (e) =>
          e.type === 'google_chat_events_status' &&
          (e.subscription as { state?: string } | null)?.state === 'SUSPENDED',
      );
    expect(event?.version).toBeGreaterThan(before);
    // Unread changes share the sequence, so numbers never collide.
    recordUnreadMessage({
      userId: 'u1',
      spaceName: 'spaces/S1',
      messageName: 'spaces/S1/messages/z',
      createTime: '2026-10-08T12:00:00Z',
    });
    expect(getUnreadSnapshot('u1').version).toBeGreaterThan(event?.version as number);
  });
});

describe('unread versions', () => {
  const rec = (id: string, t: string) =>
    recordUnreadMessage({
      userId: 'u1',
      spaceName: 'spaces/S1',
      messageName: `spaces/S1/messages/${id}`,
      createTime: t,
    });

  it('numbers every change per user, and every read takes a new number', () => {
    rec('a', '2026-10-08T12:00:00Z');
    recordUnreadMessage({
      userId: 'u1',
      spaceName: 'spaces/S2',
      messageName: 'spaces/S2/messages/x',
      createTime: '2026-10-08T12:00:00Z',
    });
    expect(rec('a', '2026-10-08T12:00:00Z')).toBe(false);
    expect(getUnreadSnapshot('u1').version).toBe(2);
    // Even a read that clears nothing supersedes earlier state.
    expect(markSpaceRead({ userId: 'u1', spaceName: 'spaces/S3' }).version).toBe(3);
    expect(markSpaceRead({ userId: 'u1', spaceName: 'spaces/S1' })).toMatchObject({
      count: 0,
      version: 4,
    });
    expect(getUnreadSnapshot('u1')).toMatchObject({
      version: 4,
      spaces: [{ spaceName: 'spaces/S2', version: 2 }],
    });
    expect(getUnreadSnapshot('u2')).toEqual({ spaces: [], version: 0 });
  });
});

describe('unread store', () => {
  const rec = (id: string, createTime: string) =>
    recordUnreadMessage({
      userId: 'u1',
      spaceName: 'spaces/S1',
      messageName: `spaces/S1/messages/${id}`,
      createTime,
    });

  it('marks read through a bound with full timestamp precision', () => {
    rec('a', '2026-10-08T12:00:00.1Z');
    rec('b', '2026-10-08T12:00:00.100001Z');
    expect(
      markSpaceRead({
        userId: 'u1',
        spaceName: 'spaces/S1',
        readThrough: '2026-10-08T12:00:00.100000Z',
      }),
    ).toMatchObject({ count: 1 });
  });

  it('does not bring back a message that was already read', () => {
    rec('a', '2026-10-08T12:00:00Z');
    markSpaceRead({ userId: 'u1', spaceName: 'spaces/S1' });
    expect(rec('a', '2026-10-08T12:00:00Z')).toBe(false);
    expect(rec('c', '2026-10-08T12:00:05Z')).toBe(true);
  });

  it('never moves the read marker backwards', () => {
    rec('a', '2026-10-08T12:00:10Z');
    markSpaceRead({ userId: 'u1', spaceName: 'spaces/S1' });
    markSpaceRead({ userId: 'u1', spaceName: 'spaces/S1', readThrough: '2026-10-08T11:00:00Z' });
    expect(rec('old', '2026-10-08T12:00:05Z')).toBe(false);
  });
});

describe('verifyPushToken', () => {
  it('accepts only a verified token for the configured service account', async () => {
    const ok = vi
      .fn()
      .mockResolvedValue({ email: CFG.pushServiceAccountEmail, email_verified: true });
    expect(await verifyPushToken('Bearer abc', CFG, ok)).toBe(true);
    expect(ok).toHaveBeenCalledWith('abc', CFG.pushAudience);
    expect(await verifyPushToken(undefined, CFG, ok)).toBe(false);
    expect(
      await verifyPushToken('Bearer abc', CFG, async () => ({
        email: 'evil@x.com',
        email_verified: true,
      })),
    ).toBe(false);
    expect(
      await verifyPushToken('Bearer abc', CFG, async () => ({
        email: CFG.pushServiceAccountEmail,
        email_verified: false,
      })),
    ).toBe(false);
    expect(
      await verifyPushToken('Bearer abc', CFG, async () => {
        throw new Error('bad signature');
      }),
    ).toBe(false);
  });
});

describe('broadcast filter for Chat events', () => {
  const filterDeps = {
    resolveProjectId: () => null,
    findProject: () => null,
    getSessionOwner: () => null,
  };
  const stamp = (userId: string) => ({ userId, role: 'Owner' as const, localBypass: false });

  it('delivers Chat events only to their owner, with no Owner-role override', () => {
    const event = { type: 'google_chat_message', ownerUserId: 'u1', spaceName: 'spaces/S1' };
    expect(shouldDeliverBroadcast(event, stamp('u1'), filterDeps)).toBe(true);
    expect(shouldDeliverBroadcast(event, stamp('u2'), filterDeps)).toBe(false);
    expect(shouldDeliverBroadcast({ type: 'google_chat_unread' }, stamp('u1'), filterDeps)).toBe(
      false,
    );
  });
});
