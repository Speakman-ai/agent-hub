import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';

(vi as any).mock('../utils/api', () => ({
  api: {
    listNotifications: vi.fn(),
    getNotificationUnreadCount: vi.fn(),
    markNotificationRead: vi.fn(),
    markAllNotificationsRead: vi.fn(),
  },
}));

import { api } from '../utils/api';
import NotificationBell, {
  NOTIFICATION_PAGE_SIZE,
  NOTIFICATION_WS_EVENT,
} from './NotificationBell';

function n(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    userId: 'u1',
    orgId: null,
    projectId: 'acme',
    category: 'card_assigned_to_you',
    title: `Title ${id}`,
    body: `Body ${id}`,
    route: null,
    data: { projectId: 'acme', cardId: `card-${id}` },
    sourceKey: `k-${id}`,
    createdAt: new Date().toISOString(),
    readAt: null,
    ...over,
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

function emit(detail: Record<string, unknown>) {
  act(() => {
    window.dispatchEvent(new CustomEvent(NOTIFICATION_WS_EVENT, { detail }));
  });
}

function setup() {
  const onOpenTarget = vi.fn();
  const onOpenSettings = vi.fn();
  render(<NotificationBell onOpenTarget={onOpenTarget} onOpenSettings={onOpenSettings} />);
  return { onOpenTarget, onOpenSettings };
}

describe('NotificationBell', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (api.getNotificationUnreadCount as any).mockResolvedValue({ count: 2 });
    (api.listNotifications as any).mockResolvedValue({
      items: [n('a'), n('b', { readAt: '2026-10-15T10:00:00.000Z' })],
      nextCursor: null,
    });
    (api.markNotificationRead as any).mockResolvedValue({ unreadCount: 1 });
    (api.markAllNotificationsRead as any).mockResolvedValue({ updated: 1, unreadCount: 0 });
  });

  it('shows the unread badge from the server count', async () => {
    setup();
    expect(await screen.findByTestId('notification-bell-badge')).toHaveTextContent('2');
  });

  it('lists rows newest first with an accent on unread rows, paged 20 at a time', async () => {
    setup();
    fireEvent.click(screen.getByTestId('notification-bell'));
    const rows = await screen.findAllByTestId('notification-row');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Title a'),
      expect.stringContaining('Title b'),
    ]);
    expect(rows[0]).toHaveAttribute('data-unread', 'true');
    expect(rows[0].className).toContain('border-l-indigo-500');
    expect(rows[1]).toHaveAttribute('data-unread', 'false');
    expect(api.listNotifications).toHaveBeenCalledWith({
      limit: NOTIFICATION_PAGE_SIZE,
      cursor: null,
    });
  });

  it('loads the next page from the cursor', async () => {
    (api.listNotifications as any)
      .mockResolvedValueOnce({ items: [n('a')], nextCursor: 'cur-1' })
      .mockResolvedValueOnce({ items: [n('c')], nextCursor: null });
    setup();
    fireEvent.click(screen.getByTestId('notification-bell'));
    fireEvent.click(await screen.findByTestId('notification-bell-load-more'));
    await waitFor(() => expect(screen.getAllByTestId('notification-row')).toHaveLength(2));
    expect(api.listNotifications).toHaveBeenLastCalledWith({
      limit: NOTIFICATION_PAGE_SIZE,
      cursor: 'cur-1',
    });
    expect(screen.queryByTestId('notification-bell-load-more')).toBeNull();
  });

  it('marks a row read and deep-links on click', async () => {
    const { onOpenTarget } = setup();
    fireEvent.click(screen.getByTestId('notification-bell'));
    const [first] = await screen.findAllByTestId('notification-row');
    fireEvent.click(first);
    expect(api.markNotificationRead).toHaveBeenCalledWith('a');
    expect(onOpenTarget).toHaveBeenCalledWith({
      kind: 'route',
      route: { view: 'kanban:acme', cardId: 'card-a' },
    });
    expect(screen.queryByTestId('notification-bell-popover')).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId('notification-bell-badge')).toHaveTextContent('1'),
    );
  });

  it('does not re-mark an already read row', async () => {
    setup();
    fireEvent.click(screen.getByTestId('notification-bell'));
    const rows = await screen.findAllByTestId('notification-row');
    fireEvent.click(rows[1]);
    expect(api.markNotificationRead).not.toHaveBeenCalled();
  });

  it('marks everything read', async () => {
    setup();
    fireEvent.click(screen.getByTestId('notification-bell'));
    await screen.findAllByTestId('notification-row');
    fireEvent.click(screen.getByTestId('notification-bell-mark-all'));
    expect(api.markAllNotificationsRead).toHaveBeenCalled();
    expect(screen.queryByTestId('notification-bell-badge')).toBeNull();
    for (const r of screen.getAllByTestId('notification-row')) {
      expect(r).toHaveAttribute('data-unread', 'false');
    }
  });

  it('applies live notification_created and notification_read events', async () => {
    setup();
    fireEvent.click(screen.getByTestId('notification-bell'));
    await screen.findAllByTestId('notification-row');

    emit({ type: 'notification_created', notification: n('z'), unreadCount: 3 });
    const rows = screen.getAllByTestId('notification-row');
    expect(rows[0]).toHaveTextContent('Title z');
    expect(screen.getByTestId('notification-bell-badge')).toHaveTextContent('3');

    emit({ type: 'notification_read', ids: ['z'], readAt: '2026-10-15T12:00:00Z', unreadCount: 2 });
    expect(screen.getAllByTestId('notification-row')[0]).toHaveAttribute('data-unread', 'false');

    emit({ type: 'notification_read', all: true, readAt: '2099-01-01T00:00:00Z', unreadCount: 0 });
    expect(screen.queryByTestId('notification-bell-badge')).toBeNull();
    for (const r of screen.getAllByTestId('notification-row')) {
      expect(r).toHaveAttribute('data-unread', 'false');
    }
  });

  it('ignores desktop-only notification_created events (inbox:false)', async () => {
    setup();
    fireEvent.click(screen.getByTestId('notification-bell'));
    const before = (await screen.findAllByTestId('notification-row')).length;
    emit({ type: 'notification_created', inbox: false, desktop: true, notification: n('z') });
    expect(screen.getAllByTestId('notification-row')).toHaveLength(before);
    expect(screen.queryByText('Title z')).toBeNull();
  });

  it('updates the badge from live events while closed', async () => {
    setup();
    await screen.findByTestId('notification-bell-badge');
    emit({ type: 'notification_created', notification: n('y'), unreadCount: 120 });
    expect(screen.getByTestId('notification-bell-badge')).toHaveTextContent('99+');
  });

  it('opens Notification settings from the footer', async () => {
    const { onOpenSettings } = setup();
    fireEvent.click(screen.getByTestId('notification-bell'));
    const popover = await screen.findByTestId('notification-bell-popover');
    fireEvent.click(within(popover).getByTestId('notification-bell-settings'));
    expect(onOpenSettings).toHaveBeenCalled();
    expect(screen.queryByTestId('notification-bell-popover')).toBeNull();
  });

  it('shows an empty state and closes on Escape', async () => {
    (api.listNotifications as any).mockResolvedValue({ items: [], nextCursor: null });
    setup();
    fireEvent.click(screen.getByTestId('notification-bell'));
    expect(await screen.findByText("You're all caught up.")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('notification-bell-popover')).toBeNull();
  });

  describe('responses that race live events', () => {
    function deferred<T>() {
      let resolve!: (v: T) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    it('keeps a notification created while the first page was in flight', async () => {
      const page = deferred<any>();
      (api.listNotifications as any).mockReturnValue(page.promise);
      setup();
      fireEvent.click(screen.getByTestId('notification-bell'));
      emit({
        type: 'notification_created',
        notification: n('live', { createdAt: new Date(Date.now() + 1000).toISOString() }),
        unreadCount: 3,
      });
      await act(async () => page.resolve({ items: [n('a')], nextCursor: null }));
      const rows = screen.getAllByTestId('notification-row');
      expect(rows.map((r) => r.textContent)).toEqual([
        expect.stringContaining('Title live'),
        expect.stringContaining('Title a'),
      ]);
    });

    it('does not revert a read event that landed while the page was in flight', async () => {
      const page = deferred<any>();
      (api.listNotifications as any).mockReturnValue(page.promise);
      setup();
      fireEvent.click(screen.getByTestId('notification-bell'));
      emit({
        type: 'notification_read',
        ids: ['a'],
        readAt: new Date().toISOString(),
        unreadCount: 0,
      });
      await act(async () => page.resolve({ items: [n('a')], nextCursor: null }));
      expect(screen.getByTestId('notification-row')).toHaveAttribute('data-unread', 'false');
    });

    it('drops a stale unread count that resolves after a live event, then asks again', async () => {
      const count = deferred<any>();
      (api.getNotificationUnreadCount as any)
        .mockReturnValueOnce(count.promise)
        .mockResolvedValue({ count: 5 });
      setup();
      emit({ type: 'notification_created', notification: n('z'), unreadCount: 5 });
      await act(async () => count.resolve({ count: 2 }));
      expect(screen.getByTestId('notification-bell-badge')).toHaveTextContent('5');
      await waitFor(() => expect(api.getNotificationUnreadCount).toHaveBeenCalledTimes(2));
      expect(screen.getByTestId('notification-bell-badge')).toHaveTextContent('5');
    });
  });

  describe('writes in flight across page fetches (no WS events)', () => {
    function deferred<T>() {
      let resolve!: (v: T) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }
    const old = (id: string) => n(id, { createdAt: '2026-01-01T00:00:00.000Z' });

    it('a pending mark-all overlays a Load more page fetched after it', async () => {
      const post = deferred<any>();
      (api.markAllNotificationsRead as any).mockReturnValue(post.promise);
      (api.listNotifications as any)
        .mockResolvedValueOnce({ items: [n('a')], nextCursor: 'cur-1' })
        .mockResolvedValueOnce({ items: [old('old')], nextCursor: null });
      setup();
      fireEvent.click(screen.getByTestId('notification-bell'));
      await screen.findByTestId('notification-bell-load-more');
      fireEvent.click(screen.getByTestId('notification-bell-mark-all'));
      fireEvent.click(screen.getByTestId('notification-bell-load-more'));
      await waitFor(() => expect(screen.getAllByTestId('notification-row')).toHaveLength(2));
      for (const r of screen.getAllByTestId('notification-row')) {
        expect(r).toHaveAttribute('data-unread', 'false');
      }
      (api.getNotificationUnreadCount as any).mockResolvedValue({ count: 0 });
      await act(async () => post.resolve({ updated: 2, unreadCount: 0 }));
      for (const r of screen.getAllByTestId('notification-row')) {
        expect(r).toHaveAttribute('data-unread', 'false');
      }
      expect(screen.queryByTestId('notification-bell-badge')).toBeNull();
    });

    it('a pending row write survives reopening the popover, then rolls back on failure', async () => {
      const post = deferred<any>();
      (api.markNotificationRead as any).mockReturnValue(post.promise);
      (api.listNotifications as any).mockResolvedValue({
        items: [n('a', { data: null, projectId: null })],
        nextCursor: null,
      });
      setup();
      fireEvent.click(screen.getByTestId('notification-bell'));
      fireEvent.click(await screen.findByTestId('notification-row'));
      // Reopen: a fresh first page still reports the row unread.
      fireEvent.click(screen.getByTestId('notification-bell'));
      fireEvent.click(screen.getByTestId('notification-bell'));
      await waitFor(() => expect(api.listNotifications).toHaveBeenCalledTimes(2));
      expect(await screen.findByTestId('notification-row')).toHaveAttribute('data-unread', 'false');
      expect(screen.getByTestId('notification-bell-badge')).toHaveTextContent('1');
      await act(async () => post.reject(new Error('boom')));
      expect(screen.getByTestId('notification-row')).toHaveAttribute('data-unread', 'true');
      expect(screen.getByTestId('notification-bell-action-error')).toBeInTheDocument();
    });

    it('defers a count refresh until the pending write settles', async () => {
      const post = deferred<any>();
      (api.markNotificationRead as any).mockReturnValue(post.promise);
      (api.listNotifications as any).mockResolvedValue({
        items: [n('a', { data: null, projectId: null })],
        nextCursor: null,
      });
      setup();
      await screen.findByTestId('notification-bell-badge');
      fireEvent.click(screen.getByTestId('notification-bell'));
      fireEvent.click(await screen.findByTestId('notification-row'));
      const countCalls = (api.getNotificationUnreadCount as any).mock.calls.length;
      fireEvent.click(screen.getByTestId('notification-bell'));
      fireEvent.click(screen.getByTestId('notification-bell'));
      await screen.findByTestId('notification-row');
      expect((api.getNotificationUnreadCount as any).mock.calls.length).toBe(countCalls);
      await act(async () => post.resolve({ unreadCount: 1 }));
      await waitFor(() =>
        expect((api.getNotificationUnreadCount as any).mock.calls.length).toBe(countCalls + 1),
      );
    });
  });

  it('out-of-order write responses cannot restore an older count (no WS events)', async () => {
    const postA = deferred<any>();
    const postB = deferred<any>();
    (api.markNotificationRead as any).mockImplementation((id: string) =>
      id === 'a' ? postA.promise : postB.promise,
    );
    (api.listNotifications as any).mockResolvedValue({
      items: [
        n('a', { data: null, projectId: null }),
        n('b', { data: null, projectId: null, createdAt: '2026-01-01T00:00:00.000Z' }),
      ],
      nextCursor: null,
    });
    setup();
    await screen.findByTestId('notification-bell-badge');
    fireEvent.click(screen.getByTestId('notification-bell'));
    // Rows without targets keep the popover open; read B while A is in flight.
    fireEvent.click((await screen.findAllByTestId('notification-row'))[0]);
    fireEvent.click(screen.getAllByTestId('notification-row')[1]);
    expect(screen.queryByTestId('notification-bell-badge')).toBeNull();
    const countCalls = (api.getNotificationUnreadCount as any).mock.calls.length;

    // Server ran A then B, but B's response (count 0) arrives before A's (count 1).
    (api.getNotificationUnreadCount as any).mockResolvedValue({ count: 0 });
    await act(async () => postB.resolve({ unreadCount: 0 }));
    expect((api.getNotificationUnreadCount as any).mock.calls.length).toBe(countCalls);
    await act(async () => postA.resolve({ unreadCount: 1 }));

    await waitFor(() =>
      expect((api.getNotificationUnreadCount as any).mock.calls.length).toBe(countCalls + 1),
    );
    expect(screen.queryByTestId('notification-bell-badge')).toBeNull();
    for (const r of screen.getAllByTestId('notification-row')) {
      expect(r).toHaveAttribute('data-unread', 'false');
    }
  });

  it('a browser clock ahead of the server does not mark later rows read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Browser runs five minutes ahead of the server.
      const serverNow = Date.parse('2026-10-15T12:00:00.000Z');
      vi.setSystemTime(serverNow + 5 * 60_000);
      (api.listNotifications as any).mockResolvedValue({
        items: [n('a', { createdAt: '2026-10-15T11:59:00.000Z' })],
        nextCursor: null,
      });
      (api.markAllNotificationsRead as any).mockResolvedValue({
        updated: 1,
        unreadCount: 0,
        readAt: new Date(serverNow).toISOString(),
      });
      (api.getNotificationUnreadCount as any).mockResolvedValue({ count: 0 });
      setup();
      fireEvent.click(screen.getByTestId('notification-bell'));
      await screen.findByTestId('notification-row');
      fireEvent.click(screen.getByTestId('notification-bell-mark-all'));
      await waitFor(() => expect(api.markAllNotificationsRead).toHaveBeenCalled());
      await act(async () => {});

      emit({
        type: 'notification_created',
        notification: n('later', {
          createdAt: new Date(serverNow + 60_000).toISOString(),
          data: null,
          projectId: null,
        }),
        unreadCount: 1,
      });
      const later = screen
        .getAllByTestId('notification-row')
        .find((r) => r.textContent?.includes('Title later'))!;
      expect(later).toHaveAttribute('data-unread', 'true');
      expect(screen.getByTestId('notification-bell-badge')).toHaveTextContent('1');
      fireEvent.click(later);
      expect(api.markNotificationRead).toHaveBeenCalledWith('later');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the popover and its settings footer inside a short viewport', async () => {
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 });
    (api.listNotifications as any).mockResolvedValue({
      items: Array.from({ length: 20 }, (_, i) => n(`r${i}`)),
      nextCursor: null,
    });
    try {
      setup();
      const bell = screen.getByTestId('notification-bell');
      bell.getBoundingClientRect = () =>
        ({ top: 20, bottom: 56, left: 10, right: 46, width: 36, height: 36 }) as DOMRect;
      fireEvent.click(bell);
      const popover = await screen.findByTestId('notification-bell-popover');
      const top = parseFloat(popover.style.top);
      const maxHeight = parseFloat(popover.style.maxHeight);
      expect(top).toBe(60);
      expect(top + maxHeight).toBeLessThanOrEqual(300 - 8);
      expect(within(popover).getByTestId('notification-bell-settings').className).toContain(
        'flex-shrink-0',
      );
    } finally {
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight });
    }
  });

  it('discards a count GET that already includes a write started after it', async () => {
    const openGet = deferred<any>();
    const post = deferred<any>();
    (api.getNotificationUnreadCount as any)
      .mockResolvedValueOnce({ count: 2 })
      .mockReturnValueOnce(openGet.promise)
      .mockResolvedValue({ count: 1 });
    (api.markNotificationRead as any).mockReturnValue(post.promise);
    (api.listNotifications as any).mockResolvedValue({
      items: [
        n('a', { data: null, projectId: null }),
        n('b', { data: null, projectId: null, createdAt: '2026-01-01T00:00:00.000Z' }),
      ],
      nextCursor: null,
    });
    setup();
    expect(await screen.findByTestId('notification-bell-badge')).toHaveTextContent('2');
    fireEvent.click(screen.getByTestId('notification-bell'));
    fireEvent.click((await screen.findAllByTestId('notification-row'))[0]);
    expect(screen.getByTestId('notification-bell-badge')).toHaveTextContent('1');

    // The server applied the read before answering the open's GET.
    await act(async () => openGet.resolve({ count: 1 }));
    expect(screen.getByTestId('notification-bell-badge')).toHaveTextContent('1');
    expect(api.getNotificationUnreadCount).toHaveBeenCalledTimes(2);

    await act(async () => post.resolve({ unreadCount: 1 }));
    await waitFor(() => expect(api.getNotificationUnreadCount).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId('notification-bell-badge')).toHaveTextContent('1');
  });

  it('a live row read elsewhere shows read once Load more returns it', async () => {
    const liveRow = n('x', { createdAt: '2026-01-01T00:00:00.000Z' });
    (api.listNotifications as any)
      .mockResolvedValueOnce({ items: [n('a')], nextCursor: 'cur-1' })
      .mockResolvedValueOnce({
        items: [{ ...liveRow, readAt: '2026-01-02T00:00:00.000Z' }],
        nextCursor: null,
      });
    setup();
    emit({ type: 'notification_created', notification: liveRow, unreadCount: 3 });
    fireEvent.click(screen.getByTestId('notification-bell'));
    fireEvent.click(await screen.findByTestId('notification-bell-load-more'));
    await waitFor(() => expect(api.listNotifications).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const x = screen
        .getAllByTestId('notification-row')
        .find((r) => r.textContent?.includes('Title x'))!;
      expect(x).toHaveAttribute('data-unread', 'false');
    });
    expect(screen.getAllByTestId('notification-row')).toHaveLength(2);
  });

  describe('failed writes', () => {
    it('rolls back a row when mark-read fails, and the next click retries', async () => {
      (api.markNotificationRead as any).mockRejectedValueOnce(new Error('boom'));
      (api.listNotifications as any).mockResolvedValue({
        items: [n('a', { data: null, projectId: null })],
        nextCursor: null,
      });
      setup();
      fireEvent.click(screen.getByTestId('notification-bell'));
      const row = await screen.findByTestId('notification-row');
      fireEvent.click(row);
      expect(await screen.findByTestId('notification-bell-action-error')).toBeInTheDocument();
      expect(screen.getByTestId('notification-row')).toHaveAttribute('data-unread', 'true');
      fireEvent.click(screen.getByTestId('notification-row'));
      expect(api.markNotificationRead).toHaveBeenCalledTimes(2);
    });

    it('rolls back every row when mark-all fails', async () => {
      (api.markAllNotificationsRead as any).mockRejectedValueOnce(new Error('boom'));
      setup();
      fireEvent.click(screen.getByTestId('notification-bell'));
      await screen.findAllByTestId('notification-row');
      fireEvent.click(screen.getByTestId('notification-bell-mark-all'));
      expect(await screen.findByTestId('notification-bell-action-error')).toBeInTheDocument();
      const rows = screen.getAllByTestId('notification-row');
      expect(rows[0]).toHaveAttribute('data-unread', 'true');
      expect(rows[1]).toHaveAttribute('data-unread', 'false');
      await waitFor(() =>
        expect(screen.getByTestId('notification-bell-badge')).toHaveTextContent('2'),
      );
    });

    it('a failed mark-all does not undo a server read that landed meanwhile', async () => {
      let rejectWrite!: (e: unknown) => void;
      (api.markAllNotificationsRead as any).mockReturnValueOnce(
        new Promise((_, rej) => {
          rejectWrite = rej;
        }),
      );
      setup();
      fireEvent.click(screen.getByTestId('notification-bell'));
      await screen.findAllByTestId('notification-row');
      emit({ type: 'notification_created', notification: n('c'), unreadCount: 3 });
      fireEvent.click(screen.getByTestId('notification-bell-mark-all'));
      emit({
        type: 'notification_read',
        ids: ['c'],
        readAt: '2099-01-01T00:00:00.000Z',
        unreadCount: 1,
      });
      await act(async () => rejectWrite(new Error('boom')));
      const byTitle = (t: string) =>
        screen.getAllByTestId('notification-row').find((r) => r.textContent?.includes(t))!;
      expect(byTitle('Title c')).toHaveAttribute('data-unread', 'false');
      expect(byTitle('Title a')).toHaveAttribute('data-unread', 'true');
    });
  });
});
