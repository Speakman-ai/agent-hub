import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';

let TMP_DIR = '';
vi.mock('./config.js', () => ({
  default: {
    apiKey: null,
    get dataDir() {
      return TMP_DIR;
    },
  },
}));

const { initOrgsDb, setOrgsDbPathForTests, getOrgsDb } = await import('./orgs.js');
const { createUser, deleteUser } = await import('./users-store.js');
const {
  insertNotification,
  getNotification,
  listNotifications,
  countUnreadNotifications,
  markNotificationRead,
  markNotificationReadBySourceKey,
  markAllNotificationsRead,
  pruneNotifications,
  runNotificationsPrune,
} = await import('./notifications-store.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-15T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

function freshDb() {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'notifications-store-test-'));
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
}

let alice = '';
let bob = '';

beforeEach(() => {
  freshDb();
  alice = createUser({ username: 'alice', passwordHash: 'x' }).id;
  bob = createUser({ username: 'bob', passwordHash: 'x' }).id;
});

describe('notifications schema', () => {
  it('creates the spec indexes, with (user_id, source_key) unique', () => {
    const idx = getOrgsDb().prepare("PRAGMA index_list('notifications')").all() as Array<{
      name: string;
      unique: number;
    }>;
    const cols = (name: string) =>
      (getOrgsDb().prepare(`PRAGMA index_info('${name}')`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
    const byCols = new Map(idx.map((i) => [cols(i.name).join(','), i.unique]));
    expect(byCols.get('user_id,source_key')).toBe(1);
    expect(byCols.has('user_id,read_at')).toBe(true);
    expect(byCols.has('user_id,created_at')).toBe(true);
  });

  it('cascades rows away when the user is deleted', () => {
    insertNotification({ userId: alice, category: 'dm', title: 'hi', sourceKey: 'k' });
    deleteUser(alice);
    const n = getOrgsDb().prepare('SELECT COUNT(*) AS n FROM notifications').get() as {
      n: number;
    };
    expect(n.n).toBe(0);
  });
});

describe('insertNotification', () => {
  it('roundtrips every field', () => {
    const { notification, created } = insertNotification({
      userId: alice,
      orgId: 'org-1',
      projectId: 'agent-hub',
      category: 'awaiting_feedback',
      title: 'Session needs you',
      body: 'Dev is waiting',
      route: '/projects/agent-hub/sessions/s1',
      data: { sessionId: 's1' },
      sourceKey: 'awaiting_feedback:s1:1',
      now: NOW,
    });
    expect(created).toBe(true);
    expect(notification).toMatchObject({
      userId: alice,
      orgId: 'org-1',
      projectId: 'agent-hub',
      category: 'awaiting_feedback',
      title: 'Session needs you',
      body: 'Dev is waiting',
      route: '/projects/agent-hub/sessions/s1',
      data: { sessionId: 's1' },
      sourceKey: 'awaiting_feedback:s1:1',
      createdAt: NOW.toISOString(),
      readAt: null,
    });
    expect(getNotification(alice, notification.id)).toEqual(notification);
    expect(getNotification(bob, notification.id)).toBeNull();
  });

  it('is idempotent on (user, sourceKey) and keeps the existing read state', () => {
    const first = insertNotification({ userId: alice, category: 'dm', title: 'a', sourceKey: 'k' });
    markNotificationRead(alice, first.notification.id, NOW);
    const second = insertNotification({
      userId: alice,
      category: 'dm',
      title: 'b',
      sourceKey: 'k',
    });
    expect(second.created).toBe(false);
    expect(second.notification.id).toBe(first.notification.id);
    expect(second.notification.title).toBe('a');
    expect(second.notification.readAt).toBe(NOW.toISOString());
  });

  it('dedupes per user, not globally', () => {
    insertNotification({ userId: alice, category: 'dm', title: 'a', sourceKey: 'k' });
    const forBob = insertNotification({ userId: bob, category: 'dm', title: 'a', sourceKey: 'k' });
    expect(forBob.created).toBe(true);
  });

  it('never dedupes rows inserted without a source key', () => {
    insertNotification({ userId: alice, category: 'dm', title: 'a' });
    insertNotification({ userId: alice, category: 'dm', title: 'a' });
    expect(countUnreadNotifications(alice)).toBe(2);
  });
});

describe('listNotifications', () => {
  it('pages newest first with a cursor and no gaps or repeats on timestamp ties', () => {
    // Two rows share each timestamp to exercise the id tie-break.
    for (let i = 0; i < 25; i++) {
      insertNotification({
        userId: alice,
        category: 'dm',
        title: `n${i}`,
        sourceKey: `k${i}`,
        now: new Date(NOW.getTime() + Math.floor(i / 2) * 1000),
      });
    }
    insertNotification({ userId: bob, category: 'dm', title: 'other', sourceKey: 'x' });

    const p1 = listNotifications(alice);
    expect(p1.items).toHaveLength(20);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = listNotifications(alice, { cursor: p1.nextCursor });
    expect(p2.items).toHaveLength(5);
    expect(p2.nextCursor).toBeNull();

    const all = [...p1.items, ...p2.items];
    expect(new Set(all.map((n) => n.id)).size).toBe(25);
    expect(all.every((n) => n.userId === alice)).toBe(true);
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].createdAt >= all[i].createdAt).toBe(true);
    }
    expect(all[0].title === 'n24' || all[0].title === 'n23').toBe(true);
  });

  it('a row inserted between page loads does not shift the next page', () => {
    for (let i = 0; i < 3; i++) {
      insertNotification({
        userId: alice,
        category: 'dm',
        title: `n${i}`,
        sourceKey: `k${i}`,
        now: new Date(NOW.getTime() + i * 1000),
      });
    }
    const p1 = listNotifications(alice, { limit: 2 });
    insertNotification({
      userId: alice,
      category: 'dm',
      title: 'late',
      sourceKey: 'late',
      now: new Date(NOW.getTime() + 60_000),
    });
    const p2 = listNotifications(alice, { limit: 2, cursor: p1.nextCursor });
    expect(p2.items.map((n) => n.title)).toEqual(['n0']);
  });

  it('filters unread only and clamps the limit', () => {
    const a = insertNotification({ userId: alice, category: 'dm', title: 'a', sourceKey: 'a' });
    insertNotification({ userId: alice, category: 'dm', title: 'b', sourceKey: 'b' });
    markNotificationRead(alice, a.notification.id);
    expect(listNotifications(alice, { unreadOnly: true }).items.map((n) => n.title)).toEqual(['b']);
    expect(listNotifications(alice, { limit: 0 }).items).toHaveLength(1);
  });

  it('treats a garbage cursor as the first page', () => {
    insertNotification({ userId: alice, category: 'dm', title: 'a', sourceKey: 'a' });
    expect(listNotifications(alice, { cursor: 'not-a-cursor' }).items).toHaveLength(1);
  });
});

describe('read state', () => {
  it('counts unread and marks one read, scoped to the owner', () => {
    const a = insertNotification({ userId: alice, category: 'dm', title: 'a', sourceKey: 'a' });
    insertNotification({ userId: alice, category: 'dm', title: 'b', sourceKey: 'b' });
    expect(countUnreadNotifications(alice)).toBe(2);

    expect(markNotificationRead(bob, a.notification.id)).toBe(false);
    expect(markNotificationRead(alice, a.notification.id, NOW)).toBe(true);
    expect(markNotificationRead(alice, a.notification.id)).toBe(false);
    expect(getNotification(alice, a.notification.id)?.readAt).toBe(NOW.toISOString());
    expect(countUnreadNotifications(alice)).toBe(1);
  });

  it('marks read by source key', () => {
    insertNotification({ userId: alice, category: 'dm', title: 'a', sourceKey: 'dm:m1' });
    expect(markNotificationReadBySourceKey(alice, 'dm:m1')).toBe(true);
    expect(countUnreadNotifications(alice)).toBe(0);
  });

  it('marks all read for one user only', () => {
    insertNotification({ userId: alice, category: 'dm', title: 'a', sourceKey: 'a' });
    insertNotification({ userId: alice, category: 'dm', title: 'b', sourceKey: 'b' });
    insertNotification({ userId: bob, category: 'dm', title: 'c', sourceKey: 'c' });
    expect(markAllNotificationsRead(alice)).toBe(2);
    expect(markAllNotificationsRead(alice)).toBe(0);
    expect(countUnreadNotifications(alice)).toBe(0);
    expect(countUnreadNotifications(bob)).toBe(1);
  });
});

describe('pruneNotifications', () => {
  function seed(key: string, ageDays: number, read: boolean) {
    const { notification } = insertNotification({
      userId: alice,
      category: 'dm',
      title: key,
      sourceKey: key,
      now: daysAgo(ageDays),
    });
    if (read) markNotificationRead(alice, notification.id, NOW);
  }

  it('drops read rows older than 30 days and unread rows older than 90 days', () => {
    seed('read-29', 29, true);
    seed('read-31', 31, true);
    seed('unread-31', 31, false);
    seed('unread-89', 89, false);
    seed('unread-91', 91, false);

    expect(pruneNotifications(NOW)).toEqual({ read: 1, unread: 1 });
    const left = listNotifications(alice, { limit: 100 }).items.map((n) => n.title);
    expect(left.sort()).toEqual(['read-29', 'unread-31', 'unread-89']);
  });

  it('runNotificationsPrune returns the counts and is a no-op on an empty table', () => {
    expect(runNotificationsPrune(NOW)).toEqual({ read: 0, unread: 0 });
  });
});
