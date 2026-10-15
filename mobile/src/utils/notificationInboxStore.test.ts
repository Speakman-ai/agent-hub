import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InboxNotification } from '@shared/utils/notificationInbox';
import {
  NOTIFICATION_PAGE_SIZE,
  badgeLabel,
  createNotificationInboxStore,
  type NotificationInboxApi,
} from './notificationInboxStore';

function row(id: string, createdAt: string, readAt: string | null = null): InboxNotification {
  return {
    id,
    userId: 'u1',
    orgId: null,
    projectId: 'p1',
    category: 'awaiting_feedback',
    title: `Row ${id}`,
    body: '',
    route: null,
    data: { sessionId: `s-${id}` },
    sourceKey: `k-${id}`,
    createdAt,
    readAt,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

function mockApi(overrides: Partial<Record<keyof NotificationInboxApi, any>> = {}) {
  return {
    list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    unreadCount: vi.fn().mockResolvedValue({ count: 0 }),
    markRead: vi.fn().mockResolvedValue({ unreadCount: 0 }),
    markAllRead: vi.fn().mockResolvedValue({ updated: 0, unreadCount: 0, readAt: 'x' }),
    ...overrides,
  };
}

describe('notification inbox store', () => {
  let api: ReturnType<typeof mockApi>;
  beforeEach(() => {
    api = mockApi();
  });

  it('stays empty and silent until enabled, then fetches the unread count', async () => {
    api.unreadCount.mockResolvedValue({ count: 3 });
    const store = createNotificationInboxStore(api);
    store.handleWsEvent({
      type: 'notification_created',
      notification: row('a', '2026-10-15T10:00:00Z'),
      unreadCount: 1,
    });
    await store.loadFirstPage();
    expect(api.unreadCount).not.toHaveBeenCalled();
    expect(api.list).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toMatchObject({ active: false, unreadCount: 0, items: [] });

    store.reset(true);
    await flush();
    expect(api.unreadCount).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({ active: true, unreadCount: 3 });
  });

  it('loads pages of 20 newest first and appends the next page by cursor', async () => {
    api.list
      .mockResolvedValueOnce({ items: [row('b', '2026-10-15T11:00:00Z')], nextCursor: 'c1' })
      .mockResolvedValueOnce({ items: [row('a', '2026-10-15T10:00:00Z')], nextCursor: null });
    const store = createNotificationInboxStore(api);
    store.reset(true);
    await store.loadFirstPage();
    expect(api.list).toHaveBeenLastCalledWith({ limit: NOTIFICATION_PAGE_SIZE, cursor: null });
    expect(store.getSnapshot().nextCursor).toBe('c1');

    await store.loadMore();
    expect(api.list).toHaveBeenLastCalledWith({ limit: NOTIFICATION_PAGE_SIZE, cursor: 'c1' });
    expect(store.getSnapshot().items.map((n) => n.id)).toEqual(['b', 'a']);
    expect(store.getSnapshot().nextCursor).toBeNull();

    await store.loadMore();
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('adds live rows and applies the server count from WS events', async () => {
    const store = createNotificationInboxStore(api);
    store.reset(true);
    await flush();
    store.handleWsEvent({
      type: 'notification_created',
      notification: row('a', '2026-10-15T10:00:00Z'),
      unreadCount: 1,
    });
    expect(store.getSnapshot().items.map((n) => n.id)).toEqual(['a']);
    expect(store.getSnapshot().unreadCount).toBe(1);

    // A desktop-only notice carries no inbox row.
    store.handleWsEvent({
      type: 'notification_created',
      inbox: false,
      notification: row('z', '2026-10-15T12:00:00Z'),
    });
    expect(store.getSnapshot().items).toHaveLength(1);

    store.handleWsEvent({
      type: 'notification_read',
      ids: ['a'],
      readAt: '2026-10-15T10:05:00Z',
      unreadCount: 0,
    });
    expect(store.getSnapshot().items[0].readAt).toBe('2026-10-15T10:05:00Z');
    expect(store.getSnapshot().unreadCount).toBe(0);
  });

  it('applies a mark-all from another device using the server readAt as cutoff', async () => {
    const store = createNotificationInboxStore(api);
    store.reset(true);
    await flush();
    store.handleWsEvent({
      type: 'notification_created',
      notification: row('old', '2026-10-15T10:00:00Z'),
      unreadCount: 1,
    });
    store.handleWsEvent({
      type: 'notification_created',
      notification: row('new', '2026-10-15T12:00:00Z'),
      unreadCount: 2,
    });
    store.handleWsEvent({
      type: 'notification_read',
      all: true,
      readAt: '2026-10-15T11:00:00Z',
      unreadCount: 1,
    });
    const byId = Object.fromEntries(store.getSnapshot().items.map((n) => [n.id, n.readAt]));
    expect(byId.old).toBe('2026-10-15T11:00:00Z');
    expect(byId.new).toBeNull();
    expect(store.getSnapshot().unreadCount).toBe(1);
  });

  it('marks a row read optimistically and confirms the badge with a fresh count GET', async () => {
    api.unreadCount.mockResolvedValue({ count: 1 });
    api.list.mockResolvedValue({ items: [row('a', '2026-10-15T10:00:00Z')], nextCursor: null });
    const write = deferred<object>();
    api.markRead.mockReturnValue(write.promise);
    const store = createNotificationInboxStore(api);
    store.reset(true);
    await store.loadFirstPage();
    await flush();
    expect(store.getSnapshot().unreadCount).toBe(1);

    store.markRead(store.getSnapshot().items[0]);
    expect(api.markRead).toHaveBeenCalledWith('a');
    expect(store.getSnapshot().items[0].readAt).not.toBeNull();
    expect(store.getSnapshot().unreadCount).toBe(0);

    const countsBefore = api.unreadCount.mock.calls.length;
    api.unreadCount.mockResolvedValue({ count: 0 });
    write.resolve({ unreadCount: 0 });
    await flush();
    expect(api.unreadCount.mock.calls.length).toBe(countsBefore + 1);
    expect(store.getSnapshot().unreadCount).toBe(0);

    // Already-read rows don't write again.
    store.markRead(store.getSnapshot().items[0]);
    expect(api.markRead).toHaveBeenCalledTimes(1);
  });

  it('rolls back a failed read and surfaces an action error', async () => {
    api.unreadCount.mockResolvedValue({ count: 1 });
    api.list.mockResolvedValue({ items: [row('a', '2026-10-15T10:00:00Z')], nextCursor: null });
    api.markRead.mockRejectedValue(new Error('boom'));
    const store = createNotificationInboxStore(api);
    store.reset(true);
    await store.loadFirstPage();
    await flush();

    store.markRead(store.getSnapshot().items[0]);
    await flush();
    expect(store.getSnapshot().items[0].readAt).toBeNull();
    expect(store.getSnapshot().unreadCount).toBe(1);
    expect(store.getSnapshot().actionError).toBe('Could not mark the notification read.');

    store.dismissActionError();
    expect(store.getSnapshot().actionError).toBeNull();
  });

  it('mark all read covers every loaded row', async () => {
    api.unreadCount.mockResolvedValue({ count: 2 });
    api.list.mockResolvedValue({
      items: [row('b', '2026-10-15T11:00:00Z'), row('a', '2026-10-15T10:00:00Z')],
      nextCursor: null,
    });
    const write = deferred<object>();
    api.markAllRead.mockReturnValue(write.promise);
    const store = createNotificationInboxStore(api);
    store.reset(true);
    await store.loadFirstPage();
    await flush();

    store.markAllRead();
    expect(store.getSnapshot().items.every((n) => n.readAt)).toBe(true);
    expect(store.getSnapshot().unreadCount).toBe(0);
    api.unreadCount.mockResolvedValue({ count: 0 });
    write.resolve({ updated: 2, unreadCount: 0, readAt: '2026-10-15T11:30:00Z' });
    await flush();
    expect(store.getSnapshot().unreadCount).toBe(0);
  });

  it('drops responses that belong to a previous account', async () => {
    const page = deferred<{ items: InboxNotification[]; nextCursor: string | null }>();
    api.list.mockReturnValueOnce(page.promise);
    const store = createNotificationInboxStore(api);
    store.reset(true);
    const pending = store.loadFirstPage();

    store.reset(true);
    page.resolve({ items: [row('stale', '2026-10-15T10:00:00Z')], nextCursor: 'x' });
    await pending;
    expect(store.getSnapshot().items).toEqual([]);
    expect(store.getSnapshot().nextCursor).toBeNull();

    store.reset(false);
    expect(store.getSnapshot()).toMatchObject({ active: false, unreadCount: 0 });
  });

  it('resync refetches the count, and the first page once the inbox was opened', async () => {
    const store = createNotificationInboxStore(api);
    store.reset(true);
    await flush();
    store.resync();
    await flush();
    expect(api.unreadCount).toHaveBeenCalledTimes(2);
    expect(api.list).not.toHaveBeenCalled();

    await store.loadFirstPage();
    store.resync();
    await flush();
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('notifies subscribers on change', async () => {
    const store = createNotificationInboxStore(api);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.reset(true);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    listener.mockClear();
    store.reset(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('caps the badge label at 99+', () => {
    expect(badgeLabel(7)).toBe('7');
    expect(badgeLabel(100)).toBe('99+');
  });
});
