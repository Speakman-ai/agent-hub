import { describe, it, expect, vi } from 'vitest';
import {
  handleBroadcastForNotifications,
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
  const inserted: InsertNotificationInput[] = [];
  const seen = new Set<string>();
  const broadcasts: Record<string, unknown>[] = [];
  const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
    const msgs = JSON.parse(String(init?.body)) as Array<{ to: string }>;
    sent.push(...msgs.map((m) => m.to));
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
  return { deps, sentTo: () => [...sent].sort(), inserted, broadcasts };
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
    expect(h.sentTo()).toEqual(['u1-phone']);
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
