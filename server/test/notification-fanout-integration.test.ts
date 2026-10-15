import { getRequest, createProject } from './helpers.js';
import { createUser } from '../users-store.js';
import { createMembership } from '../memberships-store.js';
import { getActiveOrgId } from '../orgs.js';
import { handleBroadcastForNotifications } from '../notification-fanout.js';
import { listNotifications } from '../notifications-store.js';
import { updateUserNotificationPrefs } from '../notification-prefs-store.js';

let projectId: string;

beforeAll(async () => {
  await getRequest();
  projectId = (await createProject()).id as string;
});

function member(name: string): string {
  const u = createUser({ username: `${name}-${Date.now()}-${Math.random()}`, passwordHash: 'x' });
  createMembership(u.id, getActiveOrgId(), 'User');
  return u.id;
}

describe('notification fan-out against the real stores', () => {
  it('writes inbox rows for project members who keep in_app on', async () => {
    const on = member('on');
    const off = member('off');
    updateUserNotificationPrefs(off, { escalation: { in_app: false } });
    const live: Record<string, unknown>[] = [];
    const escId = `esc-${Date.now()}`;

    const res = await handleBroadcastForNotifications(
      {
        type: 'escalation_created',
        escalation: { id: escId, project_id: projectId, type: 'blocker', title: 'Stuck' },
      },
      { broadcast: (e) => live.push(e), getAllTokens: () => [], log: () => {} },
    );

    expect(res.recipients).toEqual(expect.arrayContaining([on, off]));
    const rows = listNotifications(on).items.filter((n) => n.sourceKey === `escalation:${escId}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      category: 'escalation',
      projectId,
      title: 'Escalation: blocker',
    });
    expect(listNotifications(off).items.some((n) => n.sourceKey === `escalation:${escId}`)).toBe(
      false,
    );
    expect(live.filter((e) => e.ownerUserId === on)).toEqual([
      expect.objectContaining({ type: 'notification_created', unreadCount: 1 }),
    ]);
    expect(live.some((e) => e.ownerUserId === off)).toBe(false);
  });
});
