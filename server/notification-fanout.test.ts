import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  claimDesktopOnlyNotice,
  handleBroadcastForNotifications,
  resetDesktopOnlyDedupeForTests,
  mapBroadcastToNotification,
  tokenWantsPush,
  type FanoutDeps,
  type StoredPrefs,
} from './notification-fanout.js';
import { handleBroadcastForPush, type DeviceTokenRowWithPrefs } from './push.js';
import type { InsertNotificationInput } from './notifications-store.js';
import {
  categoryChannelDefault,
  type NotificationCategoryId,
} from '../shared/utils/notificationCategories.js';
import type { Project } from './types.js';

function token(t: string, userId: string | null, enabled?: string[]): DeviceTokenRowWithPrefs {
  return {
    id: 1,
    token: t,
    platform: 'ios',
    user_id: userId,
    created_at: '2026-10-15 00:00:00',
    last_used: null,
    enabled_events: enabled ? JSON.stringify(enabled) : null,
  };
}

function defaults(category: NotificationCategoryId): StoredPrefs {
  return {
    in_app: categoryChannelDefault(category, 'in_app'),
    desktop: categoryChannelDefault(category, 'desktop'),
    push: categoryChannelDefault(category, 'push'),
    isDefault: true,
  };
}

interface Harness {
  deps: FanoutDeps;
  sentTo: () => string[];
  sentMessages: Array<{ to: string; data?: Record<string, unknown>; categoryId?: string }>;
  inserted: InsertNotificationInput[];
  broadcasts: Record<string, unknown>[];
}

function harness(opts: {
  tokens: DeviceTokenRowWithPrefs[];
  projectUsers?: string[];
  sessionOwner?: string | null;
  projectOwner?: string | null;
  /** Whether the project is open to every org member (default true). */
  projectOpen?: boolean;
  chatUsers?: string[];
  prefs?: Record<string, Partial<Record<NotificationCategoryId, StoredPrefs>>>;
}): Harness {
  const sent: string[] = [];
  const sentMessages: Array<{ to: string; data?: Record<string, unknown>; categoryId?: string }> =
    [];
  const inserted: InsertNotificationInput[] = [];
  const seen = new Set<string>();
  const broadcasts: Record<string, unknown>[] = [];
  const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
    const msgs = JSON.parse(String(init?.body)) as Array<{
      to: string;
      data?: Record<string, unknown>;
      categoryId?: string;
    }>;
    sent.push(...msgs.map((m) => m.to));
    sentMessages.push(...msgs);
    return new Response(JSON.stringify({ data: msgs.map(() => ({ status: 'ok' })) }));
  }) as unknown as typeof fetch;
  const project = { id: 'p1', ownerUserId: opts.projectOwner ?? null } as Project;
  const deps: FanoutDeps = {
    fetchFn,
    getAllTokens: () => opts.tokens,
    removeToken: () => {},
    log: () => {},
    resolveProjectId: () => 'p1',
    findProjectById: () => project,
    getSessionOwnerById: () => opts.sessionOwner ?? null,
    getSessionAgentIdById: () => 'agent-1',
    getUserRoleById: () => 'User',
    getChatPushUserIds: () => opts.chatUsers ?? [],
    listProjectUserIds: () => opts.projectUsers ?? ['u1', 'u2', 'u3'],
    isLocalBundled: () => false,
    isProjectOpenToOrg: () => opts.projectOpen ?? true,
    getPrefs: (userId, category) => opts.prefs?.[userId]?.[category] ?? defaults(category),
    insert: (input) => {
      const key = `${input.userId}|${input.sourceKey}`;
      const created = !seen.has(key);
      seen.add(key);
      if (created) inserted.push(input);
      return {
        created,
        notification: {
          id: `n-${inserted.length}`,
          userId: input.userId,
          orgId: null,
          projectId: input.projectId ?? null,
          category: input.category,
          title: input.title,
          body: input.body ?? '',
          route: null,
          data: input.data ?? null,
          sourceKey: input.sourceKey ?? '',
          createdAt: '2026-10-15T00:00:00.000Z',
          readAt: null,
        },
      };
    },
    countUnread: () => 1,
    broadcast: (e) => broadcasts.push(e),
  };
  return { deps, sentTo: () => [...sent].sort(), sentMessages, inserted, broadcasts };
}

const LEGACY_EVENTS: Array<{ name: string; data: Record<string, unknown> }> = [
  {
    name: 'awaiting_input',
    data: { type: 'awaiting_input', waiting: true, sessionId: 's1', askIds: ['a1'] },
  },
  {
    name: 'finalize ready_to_push',
    data: {
      type: 'finalize_run_completed',
      session_id: 's1',
      run_id: 'r1',
      status: 'ready_to_push',
    },
  },
  {
    name: 'finalize pushed',
    data: { type: 'finalize_run_completed', session_id: 's1', run_id: 'r1', status: 'pushed' },
  },
  {
    name: 'card_moved to review',
    data: { type: 'card_moved', projectId: 'p1', cardId: 'c1', columnName: 'Review', moveId: 'm1' },
  },
  {
    name: 'support ticket',
    data: { type: 'support_ticket_created', projectId: 'p1', ticket: { id: 't1', subject: 'x' } },
  },
  {
    name: 'pr merged',
    data: { type: 'webhook_pr_merged', projectId: 'p1', prNumber: 7, cardTitle: 'x' },
  },
  {
    name: 'infra alert',
    data: {
      type: 'infra_alert_transition',
      projectId: 'p1',
      alertId: 'al',
      toState: 'ALARM',
      at: 1,
    },
  },
];

describe('handleBroadcastForNotifications: push parity at default prefs', () => {
  for (const { name, data } of LEGACY_EVENTS) {
    for (const sessionOwner of ['u1', null]) {
      it(`${name} (session owner ${sessionOwner ?? 'none'}) pushes the same devices as before`, async () => {
        const tokens = [
          token('u1-phone', 'u1'),
          token('u2-phone', 'u2'),
          token('u2-muted', 'u2', ['awaiting_feedback']),
          token('anon', null),
        ];
        const before = harness({ tokens, sessionOwner, projectUsers: ['u1', 'u2'] });
        await handleBroadcastForPush(data, before.deps);
        const after = harness({ tokens, sessionOwner, projectUsers: ['u1', 'u2'] });
        await handleBroadcastForNotifications(data, after.deps);
        expect(after.sentTo()).toEqual(before.sentTo());
        expect(after.sentTo().length).toBeGreaterThan(0);
      });
    }
  }

  it('a stored push=false for the category silences that user only', async () => {
    const tokens = [token('u1-phone', 'u1'), token('u2-phone', 'u2')];
    const h = harness({
      tokens,
      projectUsers: ['u1', 'u2'],
      prefs: {
        u2: {
          review_assigned_to_you: { in_app: true, desktop: false, push: false, isDefault: false },
        },
      },
    });
    await handleBroadcastForNotifications(
      { type: 'card_moved', projectId: 'p1', cardId: 'c1', columnName: 'Review', moveId: 'm1' },
      h.deps,
    );
    expect(h.sentTo()).toEqual(['u1-phone']);
  });

  it('a stored push=true turns on a category that is quiet by default', async () => {
    const h = harness({
      tokens: [token('u1-phone', 'u1')],
      prefs: {
        u1: {
          card_assigned_to_you: { in_app: true, desktop: true, push: true, isDefault: false },
        },
      },
    });
    await handleBroadcastForNotifications(
      { type: 'card_assigned', projectId: 'p1', cardId: 'c1', assignedUserId: 'u1' },
      h.deps,
    );
    expect(h.sentTo()).toEqual(['u1-phone']);
  });

  it('tags each push with its catalog category for the foreground banner gate', async () => {
    const h = harness({ tokens: [token('u1-phone', 'u1')], projectUsers: ['u1'] });
    await handleBroadcastForNotifications(
      { type: 'card_moved', projectId: 'p1', cardId: 'c1', columnName: 'Review', moveId: 'm1' },
      h.deps,
    );
    expect(h.sentMessages).toHaveLength(1);
    expect(h.sentMessages[0].data).toMatchObject({
      category: 'review_assigned_to_you',
      cardId: 'c1',
    });
  });
});

describe('handleBroadcastForNotifications: inbox + live event', () => {
  it('writes one row per recipient and emits notification_created to that user', async () => {
    const h = harness({ tokens: [], projectUsers: ['u1', 'u2'] });
    const res = await handleBroadcastForNotifications(
      { type: 'escalation_created', escalation: { id: 'e1', project_id: 'p1', title: 'Blocked' } },
      h.deps,
    );
    expect(res.recipients).toEqual(['u1', 'u2']);
    expect(h.inserted.map((r) => [r.userId, r.category, r.sourceKey])).toEqual([
      ['u1', 'escalation', 'escalation:e1'],
      ['u2', 'escalation', 'escalation:e1'],
    ]);
    expect(h.broadcasts.map((b) => [b.type, b.ownerUserId, b.desktop])).toEqual([
      ['notification_created', 'u1', false],
      ['notification_created', 'u2', false],
    ]);
  });

  it('dedupes a repeated broadcast by source key', async () => {
    const h = harness({ tokens: [], projectUsers: ['u1'] });
    const ev = { type: 'escalation_created', escalation: { id: 'e1', project_id: 'p1' } };
    await handleBroadcastForNotifications(ev, h.deps);
    await handleBroadcastForNotifications(ev, h.deps);
    expect(h.inserted).toHaveLength(1);
    expect(h.broadcasts).toHaveLength(1);
  });

  it('skips the inbox when in_app is off but still honors push', async () => {
    const h = harness({
      tokens: [token('u1-phone', 'u1')],
      sessionOwner: 'u1',
      prefs: {
        u1: { awaiting_feedback: { in_app: false, desktop: false, push: true, isDefault: false } },
      },
    });
    await handleBroadcastForNotifications(
      { type: 'awaiting_input', waiting: true, sessionId: 's1', askIds: ['a'] },
      h.deps,
    );
    expect(h.inserted).toHaveLength(0);
    expect(h.broadcasts).toHaveLength(0);
    expect(h.sentTo()).toEqual(['u1-phone']);
  });

  describe('desktop-only (in_app off, desktop on)', () => {
    beforeEach(() => resetDesktopOnlyDedupeForTests());
    const desktopOnly = {
      u1: { awaiting_feedback: { in_app: false, desktop: true, push: false, isDefault: false } },
    };
    const ev = { type: 'awaiting_input', waiting: true, sessionId: 's1', askIds: ['a'] };

    it('emits notification_created with inbox:false and writes no row', async () => {
      const h = harness({
        tokens: [token('u1-phone', 'u1')],
        sessionOwner: 'u1',
        prefs: desktopOnly,
      });
      const res = await handleBroadcastForNotifications(ev, h.deps);
      expect(h.inserted).toHaveLength(0);
      expect(res.inserted).toBe(0);
      expect(h.sentTo()).toEqual([]);
      expect(h.broadcasts).toEqual([
        {
          type: 'notification_created',
          ownerUserId: 'u1',
          inbox: false,
          desktop: true,
          notification: expect.objectContaining({
            category: 'awaiting_feedback',
            sourceKey: 'awaiting_feedback:s1:a',
            projectId: 'p1',
          }),
        },
      ]);
      expect(h.broadcasts[0]).not.toHaveProperty('unreadCount');
      expect((h.broadcasts[0].notification as Record<string, unknown>).id).toBeUndefined();
    });

    it('dedupes a repeated broadcast without an inbox row', async () => {
      const h = harness({ tokens: [], sessionOwner: 'u1', prefs: desktopOnly });
      await handleBroadcastForNotifications(ev, h.deps);
      await handleBroadcastForNotifications(ev, h.deps);
      expect(h.broadcasts).toHaveLength(1);
    });

    it('inbox rows are flagged inbox:true', async () => {
      const h = harness({ tokens: [], sessionOwner: 'u1' });
      await handleBroadcastForNotifications(ev, h.deps);
      expect(h.broadcasts[0]).toMatchObject({ inbox: true, desktop: true });
    });
  });

  it('session events go to the owner only', async () => {
    const h = harness({ tokens: [], sessionOwner: 'u1', projectUsers: ['u1', 'u2'] });
    await handleBroadcastForNotifications(
      { type: 'awaiting_input', waiting: true, sessionId: 's1', askIds: ['a'] },
      h.deps,
    );
    expect(h.inserted.map((r) => r.userId)).toEqual(['u1']);
    expect(h.broadcasts[0]).toMatchObject({ desktop: true, ownerUserId: 'u1' });
  });

  it('ignores unmapped events and suppressPush', async () => {
    const h = harness({ tokens: [], projectUsers: ['u1'] });
    await handleBroadcastForNotifications({ type: 'kanban_update', projectId: 'p1' }, h.deps);
    await handleBroadcastForNotifications(
      { type: 'escalation_created', escalation: { id: 'e1' }, suppressPush: true },
      h.deps,
    );
    expect(h.inserted).toHaveLength(0);
  });
});

describe('mapBroadcastToNotification: browser sign-in handoff', () => {
  it('notifies the session owner and links to the browser pane', () => {
    const n = mapBroadcastToNotification({
      type: 'browser_login_requested',
      sessionId: 's1',
      agentId: 'a1',
      agentName: 'Researcher',
      projectId: 'p1',
      ownerUserId: 'u1',
      request: { requestId: 'r1', domain: 'github.com', reason: 'x' },
    });
    expect(n).toMatchObject({
      category: 'browser_sign_in',
      title: 'Sign in to github.com',
      body: 'Researcher is waiting for you to sign in to github.com in its browser',
      sourceKey: 'browser_sign_in:r1',
      recipients: { kind: 'users', userIds: ['u1'] },
      data: { sessionId: 's1', pane: 'browser', type: 'browser_sign_in' },
    });
  });

  it('ignores the resolved event and malformed requests', () => {
    expect(
      mapBroadcastToNotification({ type: 'browser_login_resolved', sessionId: 's1' }),
    ).toBeNull();
    expect(
      mapBroadcastToNotification({ type: 'browser_login_requested', sessionId: 's1' }),
    ).toBeNull();
  });
});

describe('mapBroadcastToNotification: approval requests', () => {
  it('notifies the session owner with the approval id for actionable UI', () => {
    const n = mapBroadcastToNotification({
      type: 'approval_requested',
      sessionId: 's1',
      agentId: 'a1',
      agentName: 'Researcher',
      projectId: 'p1',
      ownerUserId: 'u1',
      approval: {
        id: 'ap1',
        action: 'send',
        target: 'https://mail.example.com',
        domain: 'mail.example.com',
        canRemember: true,
        expiresAt: 123,
      },
    });
    expect(n).toMatchObject({
      category: 'approval_requested',
      pushEvent: null,
      deviceScope: 'recipients',
      title: 'Approve: send',
      body: 'Researcher wants to send https://mail.example.com',
      sourceKey: 'approval_requested:ap1',
      recipients: { kind: 'users', userIds: ['u1'] },
      data: {
        sessionId: 's1',
        approvalId: 'ap1',
        canRemember: true,
        expiresAt: 123,
        type: 'approval_requested',
      },
    });
  });

  it('falls back to session recipients without an owner and ignores malformed events', () => {
    expect(
      mapBroadcastToNotification({
        type: 'approval_requested',
        sessionId: 's1',
        approval: { id: 'ap1', action: 'delete', target: 'row 4' },
      }),
    ).toMatchObject({ recipients: { kind: 'session', sessionId: 's1' } });
    expect(mapBroadcastToNotification({ type: 'approval_requested', sessionId: 's1' })).toBeNull();
    expect(mapBroadcastToNotification({ type: 'approval_resolved', sessionId: 's1' })).toBeNull();
  });

  it('pushes with the approval categoryId so the device shows Allow once / Deny', async () => {
    const h = harness({ tokens: [token('u1-phone', 'u1')], sessionOwner: 'u1' });
    await handleBroadcastForNotifications(
      {
        type: 'approval_requested',
        sessionId: 's1',
        projectId: 'p1',
        ownerUserId: 'u1',
        approval: { id: 'ap1', action: 'send', target: 'mail' },
      },
      h.deps,
    );
    expect(h.sentMessages).toHaveLength(1);
    expect(h.sentMessages[0]).toMatchObject({
      categoryId: 'approval_requested',
      data: { approvalId: 'ap1', category: 'approval_requested' },
    });
  });

  it('leaves categoryId off pushes that have no actions', async () => {
    const h = harness({ tokens: [token('u1-phone', 'u1')], projectUsers: ['u1'] });
    await handleBroadcastForNotifications(
      { type: 'card_moved', projectId: 'p1', cardId: 'c1', columnName: 'Review', moveId: 'm1' },
      h.deps,
    );
    expect(h.sentMessages[0]).not.toHaveProperty('categoryId');
  });
});

describe('mapBroadcastToNotification: new producers', () => {
  it('session_completed from a chat done event with an owner', () => {
    const n = mapBroadcastToNotification({
      type: 'done',
      sessionId: 's1',
      messageId: 'm1',
      sessionName: 'Fix bug',
      ownerUserId: 'u1',
    });
    expect(n).toMatchObject({
      category: 'session_completed',
      sourceKey: 'session_completed:m1',
      recipients: { kind: 'users', userIds: ['u1'] },
    });
    expect(mapBroadcastToNotification({ type: 'done', sessionId: 's1', messageId: 'm1' })).toBe(
      null,
    );
  });

  it('finalize_failed on failed / timed_out / infra_error, not on cancelled', () => {
    for (const status of ['failed', 'timed_out', 'infra_error']) {
      expect(
        mapBroadcastToNotification({
          type: 'finalize_run_completed',
          session_id: 's1',
          run_id: 'r1',
          status,
          failure_reason: 'ci_failed',
        }),
      ).toMatchObject({ category: 'finalize_failed', recipients: { kind: 'session' } });
    }
    expect(
      mapBroadcastToNotification({
        type: 'finalize_run_completed',
        session_id: 's1',
        run_id: 'r1',
        status: 'cancelled',
      }),
    ).toBe(null);
  });

  it('a parked review stays awaiting_feedback, not finalize_failed', () => {
    expect(
      mapBroadcastToNotification({
        type: 'finalize_run_completed',
        session_id: 's1',
        run_id: 'r1',
        status: 'failed',
        failure_reason: 'review_stalled',
      }),
    ).toMatchObject({ category: 'awaiting_feedback' });
  });

  it('card_assigned_to_you targets the assignee', () => {
    expect(
      mapBroadcastToNotification({
        type: 'card_assigned',
        projectId: 'p1',
        cardId: 'c1',
        cardTitle: 'Ship it',
        assignedUserId: 'u2',
        assignmentId: 'x',
      }),
    ).toMatchObject({
      category: 'card_assigned_to_you',
      recipients: { kind: 'users', userIds: ['u2'] },
      sourceKey: 'card_assigned:c1:u2:x',
    });
  });

  it('deploy_outcome only on terminal status, to the trigger user when known', () => {
    expect(
      mapBroadcastToNotification({
        type: 'deployment_update',
        projectId: 'p1',
        deployment: { id: 'd1', status: 'running' },
      }),
    ).toBe(null);
    expect(
      mapBroadcastToNotification({
        type: 'deployment_update',
        projectId: 'p1',
        deployment: { id: 'd1', status: 'error', environment: 'prod', triggered_by: 'u3' },
      }),
    ).toMatchObject({
      category: 'deploy_outcome',
      title: 'Deploy failed',
      sourceKey: 'deploy:d1:error',
      recipients: { kind: 'users', userIds: ['u3'] },
    });
    expect(
      mapBroadcastToNotification({
        type: 'deployment_update',
        projectId: 'p1',
        deployment: { id: 'd1', status: 'success' },
      }),
    ).toMatchObject({ recipients: { kind: 'project' } });
  });
});

describe('mapBroadcastToNotification: PR environment ready', () => {
  const env = {
    id: 'env1',
    projectId: 'p1',
    prNumber: 12,
    headBranch: 'feat/x',
    headSha: 'abc123',
    url: 'https://pr-12--p1.example.com',
    readyAt: '2026-10-20T10:00:00.000Z',
  };

  it('ignores every status but ready', () => {
    for (const status of ['queued', 'building', 'failed', 'stopped']) {
      expect(
        mapBroadcastToNotification({
          type: 'pr_environment_update',
          projectId: 'p1',
          prNumber: 12,
          status,
          environment: { ...env, readyAt: null },
        }),
      ).toBe(null);
    }
  });

  it('notifies the addressed users once per head commit, linking the PR', () => {
    const intent = mapBroadcastToNotification({
      type: 'pr_environment_update',
      projectId: 'p1',
      prNumber: 12,
      status: 'ready',
      environment: env,
      notifyUserIds: ['u1', 'u2'],
    });
    expect(intent).toMatchObject({
      category: 'pr_environment_ready',
      title: 'PR #12 preview is ready',
      body: 'https://pr-12--p1.example.com',
      data: { projectId: 'p1', prNumber: 12, type: 'pr_environment_ready' },
      sourceKey: 'pr_env_ready:env1:abc123',
      recipients: { kind: 'users', userIds: ['u1', 'u2'] },
      deviceScope: 'recipients',
    });
  });

  it('falls back to project viewers when nobody is addressed', () => {
    expect(
      mapBroadcastToNotification({
        type: 'pr_environment_update',
        projectId: 'p1',
        prNumber: 12,
        status: 'ready',
        environment: env,
      }),
    ).toMatchObject({ recipients: { kind: 'project' } });
  });

  const readyKey = (environment: Record<string, unknown>) =>
    mapBroadcastToNotification({
      type: 'pr_environment_update',
      projectId: 'p1',
      prNumber: 12,
      status: 'ready',
      environment,
    })?.sourceKey;

  it('a rebuild at the same head (runner loss, wake, retry) keeps the key', () => {
    expect(readyKey({ ...env, readyAt: '2026-10-20T11:00:00.000Z' })).toBe(readyKey(env));
  });

  it('a new head commit gets a new key', () => {
    const next = { ...env, headSha: 'def456', readyAt: '2026-10-20T11:00:00.000Z' };
    expect(readyKey(next)).not.toBe(readyKey(env));
  });

  it('falls back to readyAt when the head is unknown', () => {
    const { headSha: _drop, ...noHead } = env;
    expect(readyKey(noHead)).toBe('pr_env_ready:env1:2026-10-20T10:00:00.000Z');
  });
});

describe('tokenWantsPush', () => {
  it('stored choice wins, else enabled_events for legacy events, else catalog default', () => {
    const t = token('x', 'u1', ['pushed']);
    const stored: StoredPrefs = { in_app: true, desktop: false, push: true, isDefault: false };
    expect(tokenWantsPush(t, { category: 'pr_merged', pushEvent: 'pr_merged' }, stored)).toBe(true);
    expect(
      tokenWantsPush(t, { category: 'pr_merged', pushEvent: 'pr_merged' }, defaults('pr_merged')),
    ).toBe(false);
    expect(
      tokenWantsPush(t, { category: 'escalation', pushEvent: null }, defaults('escalation')),
    ).toBe(false);
  });
});

describe('handleBroadcastForNotifications: Hub Chat', () => {
  const dm = {
    type: 'hub_chat_message',
    channelId: 'ch-dm',
    channelKind: 'dm',
    authorName: 'Alice',
    message: { id: 'msg-1', body: 'hi', refs: [] },
  };
  const channelPost = {
    type: 'hub_chat_message',
    channelId: 'ch-1',
    channelKind: 'channel',
    channelName: 'general',
    authorName: 'Alice',
    message: { id: 'msg-2', body: 'hey @bob', refs: [{ kind: 'user', targetId: 'u2' }] },
  };
  const tokens = [
    token('u1-phone', 'u1'),
    token('u2-phone', 'u2'),
    token('u3-phone', 'u3'),
    token('u3-chat-off', 'u3', ['awaiting_feedback']),
    token('anon', null),
  ];

  for (const [name, data] of [
    ['dm', dm],
    ['channel post with mention', channelPost],
  ] as const) {
    it(`${name} pushes the same devices as before at default prefs`, async () => {
      const before = harness({ tokens, chatUsers: ['u2', 'u3'] });
      await handleBroadcastForPush(data, before.deps);
      const after = harness({ tokens, chatUsers: ['u2', 'u3'] });
      await handleBroadcastForNotifications(data, after.deps);
      expect(after.sentTo()).toEqual(before.sentTo());
      expect(after.sentTo()).toEqual(['u2-phone', 'u3-phone']);
    });
  }

  it('a DM writes a dm inbox row and live event for each notified member', async () => {
    const h = harness({ tokens: [], chatUsers: ['u2'] });
    await handleBroadcastForNotifications(dm, h.deps);
    expect(h.inserted.map((r) => [r.userId, r.category, r.sourceKey])).toEqual([
      ['u2', 'dm', 'hub_chat:msg-1'],
    ]);
    expect(h.broadcasts).toEqual([
      expect.objectContaining({ type: 'notification_created', ownerUserId: 'u2', desktop: true }),
    ]);
  });

  it('a mention writes a mention row; plain channel traffic writes none', async () => {
    // u3 is notified only because their notify_level is `all`.
    const h = harness({ tokens: [], chatUsers: ['u2', 'u3'] });
    await handleBroadcastForNotifications(channelPost, h.deps);
    expect(h.inserted.map((r) => [r.userId, r.category])).toEqual([['u2', 'mention']]);
  });

  it('members chatPushRecipients would not notify get nothing', async () => {
    const h = harness({ tokens, chatUsers: [] });
    const res = await handleBroadcastForNotifications(dm, h.deps);
    expect(res).toEqual({ recipients: [], inserted: 0, pushed: 0 });
    expect(h.sentTo()).toEqual([]);
  });

  it('stored dm prefs gate both the inbox and push', async () => {
    const h = harness({
      tokens,
      chatUsers: ['u2', 'u3'],
      prefs: {
        u2: { dm: { in_app: false, desktop: false, push: false, isDefault: false } },
        u3: { dm: { in_app: true, desktop: false, push: true, isDefault: false } },
      },
    });
    await handleBroadcastForNotifications(dm, h.deps);
    expect(h.inserted.map((r) => r.userId)).toEqual(['u3']);
    // u3 saved push on for DMs, which outranks the device-level chat opt-out.
    expect(h.sentTo()).toEqual(['u3-chat-off', 'u3-phone']);
  });

  it('a stored mention pref does not affect plain channel traffic', async () => {
    const h = harness({
      tokens: [token('u3-phone', 'u3')],
      chatUsers: ['u3'],
      prefs: { u3: { mention: { in_app: true, desktop: false, push: false, isDefault: false } } },
    });
    await handleBroadcastForNotifications(channelPost, h.deps);
    expect(h.sentTo()).toEqual(['u3-phone']);
    expect(h.inserted).toHaveLength(0);
  });

  it('a deleted message notifies no one', async () => {
    const h = harness({ tokens, chatUsers: ['u2'] });
    await handleBroadcastForNotifications(
      { ...dm, message: { ...dm.message, deletedAt: '2026-10-15' } },
      h.deps,
    );
    expect(h.inserted).toHaveLength(0);
    expect(h.sentTo()).toEqual([]);
  });
});

describe('handleBroadcastForNotifications: project access gates every routing kind', () => {
  const revokedPrefs = {
    in_app: true,
    desktop: true,
    push: true,
    isDefault: false,
  } as const;

  it('an explicit recipient (card assignee) who lost project access gets nothing', async () => {
    const h = harness({
      tokens: [token('u9-phone', 'u9')],
      projectUsers: ['u1'],
      prefs: { u9: { card_assigned_to_you: revokedPrefs } },
    });
    const res = await handleBroadcastForNotifications(
      { type: 'card_assigned', projectId: 'p1', cardId: 'c1', assignedUserId: 'u9' },
      h.deps,
    );
    expect(res).toEqual({ recipients: [], inserted: 0, pushed: 0 });
    expect(h.broadcasts).toEqual([]);
    expect(h.sentTo()).toEqual([]);
  });

  it('a deploy trigger user who lost project access gets nothing', async () => {
    const h = harness({
      tokens: [token('u9-phone', 'u9')],
      projectUsers: ['u1'],
      prefs: { u9: { deploy_outcome: revokedPrefs } },
    });
    await handleBroadcastForNotifications(
      {
        type: 'deployment_update',
        projectId: 'p1',
        deployment: { id: 'd1', status: 'error', triggered_by: 'u9' },
      },
      h.deps,
    );
    expect([h.inserted, h.broadcasts, h.sentTo()]).toEqual([[], [], []]);
  });

  for (const [name, data] of [
    [
      'awaiting_input (legacy push)',
      { type: 'awaiting_input', waiting: true, sessionId: 's1', askIds: ['a'] },
    ],
    [
      'finalize_failed (recipient push)',
      { type: 'finalize_run_completed', session_id: 's1', run_id: 'r1', status: 'failed' },
    ],
    ['session_completed', { type: 'done', sessionId: 's1', messageId: 'm1', ownerUserId: 'u9' }],
  ] as const) {
    it(`${name}: a session owner who lost project access gets nothing`, async () => {
      const h = harness({
        tokens: [token('u9-phone', 'u9')],
        sessionOwner: 'u9',
        projectUsers: ['u1'],
        prefs: {
          u9: {
            awaiting_feedback: revokedPrefs,
            finalize_failed: revokedPrefs,
            session_completed: revokedPrefs,
          },
        },
      });
      await handleBroadcastForNotifications(data, h.deps);
      expect([h.inserted, h.broadcasts, h.sentTo()]).toEqual([[], [], []]);
    });
  }

  it('a session owner who still has access is notified', async () => {
    const h = harness({
      tokens: [token('u9-phone', 'u9')],
      sessionOwner: 'u9',
      projectUsers: ['u9'],
    });
    await handleBroadcastForNotifications(
      { type: 'awaiting_input', waiting: true, sessionId: 's1', askIds: ['a'] },
      h.deps,
    );
    expect(h.inserted.map((r) => r.userId)).toEqual(['u9']);
    expect(h.sentTo()).toEqual(['u9-phone']);
  });

  it('an event whose project cannot be resolved notifies no one', async () => {
    const h = harness({ tokens: [token('u1-phone', 'u1')], sessionOwner: 'u1' });
    h.deps.resolveProjectId = () => null;
    await handleBroadcastForNotifications(
      { type: 'awaiting_input', waiting: true, sessionId: 's1', askIds: ['a'] },
      h.deps,
    );
    expect([h.inserted, h.broadcasts, h.sentTo()]).toEqual([[], [], []]);
  });

  it('local mode keeps pushing to devices with no user id', async () => {
    const h = harness({ tokens: [token('anon', null)], projectUsers: [] });
    h.deps.isLocalBundled = () => true;
    await handleBroadcastForNotifications(
      { type: 'support_ticket_created', projectId: 'p1', ticket: { id: 't1', subject: 'x' } },
      h.deps,
    );
    expect(h.sentTo()).toEqual(['anon']);
  });
});

describe('handleBroadcastForNotifications: devices with no user id', () => {
  const ticket = {
    type: 'support_ticket_created',
    projectId: 'p1',
    ticket: { id: 't1', subject: 'x' },
  };
  const tokens = [token('u1-phone', 'u1'), token('anon', null)];

  it('keep getting legacy pushes for a project open to the whole org', async () => {
    const h = harness({ tokens, projectUsers: ['u1'] });
    await handleBroadcastForNotifications(ticket, h.deps);
    expect(h.sentTo()).toEqual(['anon', 'u1-phone']);
  });

  it('get nothing for a private or restricted project', async () => {
    const h = harness({ tokens, projectUsers: ['u1'], projectOpen: false });
    await handleBroadcastForNotifications(ticket, h.deps);
    expect(h.sentTo()).toEqual(['u1-phone']);
  });

  it('get nothing when the project ACL cannot be read', async () => {
    const h = harness({ tokens, projectUsers: ['u1'] });
    h.deps.isProjectOpenToOrg = () => {
      throw new Error('orgs.db locked');
    };
    await handleBroadcastForNotifications(ticket, h.deps);
    expect(h.sentTo()).toEqual(['u1-phone']);
  });

  it('never get recipient-scoped categories', async () => {
    const h = harness({
      tokens,
      projectUsers: ['u1'],
      prefs: {
        u1: {
          escalation: { in_app: true, desktop: false, push: true, isDefault: false },
        },
      },
    });
    await handleBroadcastForNotifications(
      { type: 'escalation_created', escalation: { id: 'e1', project_id: 'p1' } },
      h.deps,
    );
    expect(h.sentTo()).toEqual(['u1-phone']);
  });
});

describe('claimDesktopOnlyNotice', () => {
  beforeEach(() => resetDesktopOnlyDedupeForTests());

  it('claims once per user and key within the TTL', () => {
    expect(claimDesktopOnlyNotice('u1', 'k', 0)).toBe(true);
    expect(claimDesktopOnlyNotice('u1', 'k', 1000)).toBe(false);
    expect(claimDesktopOnlyNotice('u2', 'k', 1000)).toBe(true);
    expect(claimDesktopOnlyNotice('u1', 'k', 11 * 60 * 1000)).toBe(true);
  });
});

describe('mapBroadcastToNotification: routine runs', () => {
  it('puts the run result in the cron owner inbox, linked to the run session', () => {
    const n = mapBroadcastToNotification({
      type: 'routine_run_finished',
      sessionId: 's9',
      agentId: 'ops',
      projectId: 'p1',
      cronId: 7,
      cronName: 'Weekly export',
      logId: 42,
      status: 'success',
      preview: 'Exported 12 rows.',
      ownerUserId: 'u1',
    });
    expect(n).toMatchObject({
      category: 'routine_run',
      title: 'Routine finished: Weekly export',
      body: 'Exported 12 rows.',
      sourceKey: 'routine_run:7:42',
      recipients: { kind: 'users', userIds: ['u1'] },
      data: { sessionId: 's9', cronId: 7, status: 'success', type: 'routine_run' },
    });
  });

  it('notifies the owner of a run that never got a session, without a session link', () => {
    const n = mapBroadcastToNotification({
      type: 'routine_run_finished',
      sessionId: null,
      projectId: 'p1',
      cronId: 7,
      cronName: 'Weekly export',
      logId: 44,
      status: 'error',
      preview: 'Routine failed: Routine session failed to start: boom',
      ownerUserId: 'u1',
    });
    expect(n).toMatchObject({
      category: 'routine_run',
      title: 'Routine failed: Weekly export',
      projectId: 'p1',
      recipients: { kind: 'users', userIds: ['u1'] },
      data: { projectId: 'p1', cronId: 7, logId: 44, type: 'routine_run' },
    });
    expect(n?.data).not.toHaveProperty('sessionId');
  });

  it('titles failures and drops events without a run id', () => {
    expect(
      mapBroadcastToNotification({
        type: 'routine_run_finished',
        sessionId: 's9',
        cronId: 7,
        logId: 43,
        cronName: 'X',
        status: 'error',
      })?.title,
    ).toBe('Routine failed: X');
    expect(
      mapBroadcastToNotification({ type: 'routine_run_finished', sessionId: 's9', cronId: 7 }),
    ).toBeNull();
    expect(mapBroadcastToNotification({ type: 'routine_run_finished', logId: 1 })).toBeNull();
  });
});

describe('mapBroadcastToNotification: needs-input credential card', () => {
  it('notifies the owner when a session waits on a password or secret', () => {
    const n = mapBroadcastToNotification({
      type: 'session_needs_input',
      sessionId: 's1',
      agentId: 'a1',
      ownerUserId: 'u1',
      sessionName: 'Ship it',
      needsInput: 'credential',
    });
    expect(n).toMatchObject({
      category: 'awaiting_feedback',
      title: 'Password or secret needed',
      recipients: { kind: 'users', userIds: ['u1'] },
    });
    expect(n?.body).toContain('"Ship it"');
  });

  it('leaves other reasons to their own notifications', () => {
    for (const needsInput of ['question', 'approval', 'sign_in', 'review_disputed', null]) {
      expect(
        mapBroadcastToNotification({ type: 'session_needs_input', sessionId: 's1', needsInput }),
      ).toBeNull();
    }
  });
});
