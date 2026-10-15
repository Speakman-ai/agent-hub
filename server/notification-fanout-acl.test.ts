/**
 * Recipient resolution must fail closed: when the project ACL, membership or
 * prefs cannot be read, nobody gets an inbox row, live event or push.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const acl = vi.hoisted(() => ({
  restricted: (): Set<string> => new Set(['p1']),
  assigned: (userId: string): Set<string> => new Set(userId === 'member' ? ['p1'] : []),
  members: (): Array<{ userId: string; role: string }> => [
    { userId: 'member', role: 'User' },
    { userId: 'outsider', role: 'User' },
  ],
}));

vi.mock('./project-members-store.js', () => ({
  restrictedProjectIds: () => acl.restricted(),
  assignedProjectIdsForUser: (userId: string) => acl.assigned(userId),
}));
vi.mock('./memberships-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./memberships-store.js')>()),
  listMembersForOrg: () => acl.members(),
}));
vi.mock('./orgs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./orgs.js')>()),
  getActiveOrgId: () => 'org-1',
}));

const { handleBroadcastForNotifications } = await import('./notification-fanout.js');
import type { FanoutDeps } from './notification-fanout.js';
import type { DeviceTokenRowWithPrefs } from './push.js';
import type { Project } from './types.js';
import type { NotificationCategoryId } from '../shared/utils/notificationCategories.js';

function token(t: string, userId: string | null): DeviceTokenRowWithPrefs {
  return {
    id: 1,
    token: t,
    platform: 'ios',
    user_id: userId,
    created_at: '2026-10-15 00:00:00',
    last_used: null,
    enabled_events: null,
  };
}

const loud = { in_app: true, desktop: true, push: true, isDefault: false };

function harness(getPrefs?: FanoutDeps['getPrefs']) {
  const sent: string[] = [];
  const inserted: string[] = [];
  const live: Record<string, unknown>[] = [];
  const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
    const msgs = JSON.parse(String(init?.body)) as Array<{ to: string }>;
    sent.push(...msgs.map((m) => m.to));
    return new Response(JSON.stringify({ data: msgs.map(() => ({ status: 'ok' })) }));
  }) as unknown as typeof fetch;
  const project = { id: 'p1', ownerUserId: null, visibility: 'shared' } as unknown as Project;
  const deps: FanoutDeps = {
    fetchFn,
    getAllTokens: () => [
      token('member-phone', 'member'),
      token('outsider-phone', 'outsider'),
      token('anon', null),
    ],
    removeToken: () => {},
    log: () => {},
    resolveProjectId: () => 'p1',
    findProjectById: (id) => (id === 'p1' ? project : null),
    getSessionOwnerById: () => null,
    getSessionAgentIdById: () => null,
    isLocalBundled: () => false,
    getPrefs: getPrefs ?? ((_u: string, _c: NotificationCategoryId) => loud),
    insert: (input) => {
      inserted.push(input.userId);
      return {
        created: true,
        notification: { id: 'n', userId: input.userId } as never,
      };
    },
    countUnread: () => 1,
    broadcast: (e) => live.push(e),
  };
  return { deps, sent, inserted, live };
}

const escalation = {
  type: 'escalation_created',
  escalation: { id: 'e1', project_id: 'p1', title: 'Secret project problem' },
};
const cardReview = {
  type: 'card_moved',
  projectId: 'p1',
  cardId: 'c1',
  columnName: 'Review',
  moveId: 'm1',
};

beforeEach(() => {
  acl.restricted = () => new Set(['p1']);
  acl.members = () => [
    { userId: 'member', role: 'User' },
    { userId: 'outsider', role: 'User' },
  ];
});

describe('notification fan-out fails closed', () => {
  it('a restricted project reaches only its assigned members', async () => {
    const h = harness();
    await handleBroadcastForNotifications(escalation, h.deps);
    expect(h.inserted).toEqual(['member']);
    expect(h.live.map((e) => e.ownerUserId)).toEqual(['member']);
    expect(h.sent).toEqual(['member-phone']);
  });

  for (const ev of [escalation, cardReview]) {
    it(`${ev.type}: failed restriction lookup sends no inbox row, live event or push`, async () => {
      acl.restricted = () => {
        throw new Error('orgs.db locked');
      };
      const h = harness();
      const res = await handleBroadcastForNotifications(ev, h.deps);
      expect(res).toEqual({ recipients: [], inserted: 0, pushed: 0 });
      expect(h.inserted).toEqual([]);
      expect(h.live).toEqual([]);
      expect(h.sent).toEqual([]);
    });
  }

  it('failed membership lookup notifies no one', async () => {
    acl.members = () => {
      throw new Error('orgs.db locked');
    };
    const h = harness();
    await handleBroadcastForNotifications(escalation, h.deps);
    expect([h.inserted, h.live, h.sent]).toEqual([[], [], []]);
  });

  it('failed project resolution notifies no one', async () => {
    const h = harness();
    h.deps.resolveProjectId = () => {
      throw new Error('resolver down');
    };
    await handleBroadcastForNotifications(
      { type: 'awaiting_input', waiting: true, sessionId: 's1', askIds: ['a'] },
      h.deps,
    );
    expect([h.inserted, h.live, h.sent]).toEqual([[], [], []]);
  });

  it('an unknown project id notifies no one', async () => {
    const h = harness();
    await handleBroadcastForNotifications(
      { type: 'escalation_created', escalation: { id: 'e2', project_id: 'gone' } },
      h.deps,
    );
    expect([h.inserted, h.live, h.sent]).toEqual([[], [], []]);
  });

  it('a user whose prefs cannot be read gets no row and no push', async () => {
    acl.restricted = () => new Set();
    const h = harness((userId) => {
      if (userId === 'outsider') throw new Error('prefs unreadable');
      return loud;
    });
    await handleBroadcastForNotifications(cardReview, h.deps);
    expect(h.inserted).toEqual(['member']);
    expect(h.sent.sort()).toEqual(['anon', 'member-phone']);
  });
});

describe('unattributed devices use the real project ACL', () => {
  it('a restricted project never reaches a device with no user id', async () => {
    const h = harness();
    await handleBroadcastForNotifications(cardReview, h.deps);
    expect(h.sent).toEqual(['member-phone']);
  });

  it('an unrestricted shared project still reaches it (push parity)', async () => {
    acl.restricted = () => new Set();
    const h = harness();
    await handleBroadcastForNotifications(cardReview, h.deps);
    expect(h.sent.sort()).toEqual(['anon', 'member-phone', 'outsider-phone']);
  });
});
