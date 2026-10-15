import type { ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;

function nativeHost(name: string) {
  return ({ children, ...props }: any) => React.createElement(name, props, children);
}

const testState = vi.hoisted(() => ({
  navigate: vi.fn(),
  openInboxNotification: vi.fn(),
  api: {
    listMyApprovals: vi.fn(),
    answerApproval: vi.fn(),
    notifications: {
      list: vi.fn(),
      unreadCount: vi.fn(),
      markRead: vi.fn(),
      markAllRead: vi.fn(),
    },
  },
}));

vi.mock('react-native', () => ({
  ActivityIndicator: nativeHost('ActivityIndicator'),
  FlatList: ({ data, renderItem, ListEmptyComponent, ListFooterComponent, ...props }: any) =>
    React.createElement(
      'FlatList',
      props,
      data.length ? data.map((item: any) => renderItem({ item })) : ListEmptyComponent,
      ListFooterComponent,
    ),
  RefreshControl: nativeHost('RefreshControl'),
  StyleSheet: { create: (styles: any) => styles },
  Text: nativeHost('Text'),
  TouchableOpacity: nativeHost('TouchableOpacity'),
  View: nativeHost('View'),
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: nativeHost('SafeAreaView') }));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: testState.navigate }),
}));
vi.mock('../components/AppIcon', () => ({ default: nativeHost('AppIcon') }));
vi.mock('../context/AppContext', () => ({
  useApp: () => ({ openInboxNotification: testState.openInboxNotification }),
}));
vi.mock('../utils/api', () => ({ api: testState.api }));

const { default: NotificationsScreen } = await import('./NotificationsScreen');
const { default: NotificationBell } = await import('../components/NotificationBell');
const { notificationInboxStore } = await import('../utils/notificationInboxInstance');

function row(id: string, createdAt: string, readAt: string | null = null) {
  return {
    id,
    userId: 'u1',
    orgId: null,
    projectId: 'p1',
    category: 'awaiting_feedback',
    title: `Title ${id}`,
    body: `Body ${id}`,
    route: null,
    data: { sessionId: `s-${id}` },
    sourceKey: `k-${id}`,
    createdAt,
    readAt,
  };
}

async function flush() {
  await TestRenderer.act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

async function render(el: any) {
  let r!: ReactTestRenderer;
  await TestRenderer.act(async () => {
    r = TestRenderer.create(el);
  });
  await flush();
  return r;
}

const texts = (r: ReactTestRenderer) =>
  r.root.findAllByType('Text' as any).flatMap((t) => [].concat(t.props.children));

describe('mobile notification inbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const n = testState.api.notifications;
    n.unreadCount.mockResolvedValue({ count: 2 });
    n.list.mockResolvedValue({
      items: [row('a', '2026-10-15T10:00:00Z'), row('b', '2026-10-15T09:00:00Z', 'x')],
      nextCursor: 'c1',
    });
    n.markRead.mockResolvedValue({ unreadCount: 1 });
    n.markAllRead.mockResolvedValue({ updated: 1, unreadCount: 0, readAt: '2026-10-15T10:01:00Z' });
    testState.openInboxNotification.mockImplementation((item: any) => {
      notificationInboxStore.markRead(item);
      return { kind: 'chat', sessionId: item.data.sessionId, agentId: null };
    });
    notificationInboxStore.reset(true);
  });

  it('shows the bell badge from the unread count and opens the inbox', async () => {
    const onPress = vi.fn();
    const r = await render(<NotificationBell onPress={onPress} testID="bell" />);
    expect(r.root.findByProps({ testID: 'bell-badge' })).toBeTruthy();
    expect(texts(r)).toContain('2');
    r.root.findByProps({ testID: 'bell' }).props.onPress();
    expect(onPress).toHaveBeenCalled();

    await TestRenderer.act(async () => {
      notificationInboxStore.handleWsEvent({
        type: 'notification_created',
        notification: row('c', '2026-10-15T11:00:00Z'),
        unreadCount: 3,
      });
    });
    expect(texts(r)).toContain('3');
  });

  it('hides the bell while no account is connected', async () => {
    notificationInboxStore.reset(false);
    const r = await render(<NotificationBell onPress={vi.fn()} testID="bell" />);
    expect(r.root.findAllByType('TouchableOpacity' as any)).toHaveLength(0);
  });

  it('lists rows newest first, opens a row, and pages on scroll', async () => {
    const r = await render(<NotificationsScreen />);
    expect(testState.api.notifications.list).toHaveBeenCalledWith({ limit: 20, cursor: null });
    const rows = r.root.findAll((n) => /^notification-row-/.test(n.props.testID ?? ''), {
      deep: true,
    });
    expect(rows.filter((n) => typeof n.type === 'string').map((n) => n.props.testID)).toEqual([
      'notification-row-a',
      'notification-row-b',
    ]);

    await TestRenderer.act(async () => {
      r.root.findByProps({ testID: 'notification-row-a' }).props.onPress();
    });
    expect(testState.openInboxNotification).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a' }),
    );
    expect(testState.api.notifications.markRead).toHaveBeenCalledWith('a');
    expect(testState.navigate).toHaveBeenCalledWith('Chat');

    testState.api.notifications.list.mockResolvedValueOnce({
      items: [row('old', '2026-10-14T09:00:00Z')],
      nextCursor: null,
    });
    await TestRenderer.act(async () => {
      r.root.findByType('FlatList' as any).props.onEndReached();
    });
    await flush();
    expect(testState.api.notifications.list).toHaveBeenLastCalledWith({ limit: 20, cursor: 'c1' });
    expect(r.root.findByProps({ testID: 'notification-row-old' })).toBeTruthy();
  });

  it('marks all read and links to notification settings', async () => {
    const r = await render(<NotificationsScreen />);
    await TestRenderer.act(async () => {
      r.root.findByProps({ testID: 'notifications-mark-all' }).props.onPress();
    });
    await flush();
    expect(testState.api.notifications.markAllRead).toHaveBeenCalled();
    expect(notificationInboxStore.getSnapshot().items.every((n) => n.readAt)).toBe(true);

    r.root.findByProps({ testID: 'notifications-settings' }).props.onPress();
    expect(testState.navigate).toHaveBeenCalledWith('Settings', { tab: 'notifications' });
  });

  it('shows the empty state when nothing is there', async () => {
    testState.api.notifications.unreadCount.mockResolvedValue({ count: 0 });
    testState.api.notifications.list.mockResolvedValue({ items: [], nextCursor: null });
    const r = await render(<NotificationsScreen />);
    expect(texts(r).join('')).toContain('all caught up');
  });
});

describe('mobile notification inbox: approval rows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const n = testState.api.notifications;
    n.unreadCount.mockResolvedValue({ count: 1 });
    n.list.mockResolvedValue({
      items: [
        {
          ...row('ap-row', '2026-10-15T10:00:00Z'),
          category: 'approval_requested',
          data: { sessionId: 's1', approvalId: 'ap1', type: 'approval_requested' },
        },
        {
          ...row('old', '2026-10-15T09:00:00Z'),
          category: 'approval_requested',
          data: { sessionId: 's1', approvalId: 'ap-gone', type: 'approval_requested' },
        },
      ],
      nextCursor: null,
    });
    n.markRead.mockResolvedValue({ unreadCount: 0 });
    testState.api.listMyApprovals.mockResolvedValue({
      approvals: [{ id: 'ap1', status: 'pending', canRemember: false, requestedAt: 1 }],
    });
    testState.api.answerApproval.mockResolvedValue({ approval: { id: 'ap1' }, ruleId: null });
    notificationInboxStore.reset(true);
  });

  const hosts = (r: ReactTestRenderer, id: string) =>
    r.root.findAll((n) => n.props.testID === id && typeof n.type === 'string');

  it('shows Allow once / Deny only on rows whose approval is pending', async () => {
    const r = await render(<NotificationsScreen />);
    expect(testState.api.listMyApprovals).toHaveBeenCalledWith({ status: 'pending' });
    expect(hosts(r, 'notification-approval-ap-row')).toHaveLength(1);
    expect(hosts(r, 'notification-approval-old')).toHaveLength(0);
    expect(hosts(r, 'notification-approval-ap-row-allow_once')).toHaveLength(1);
    expect(hosts(r, 'notification-approval-ap-row-always_allow')).toHaveLength(0);
  });

  it('answers from the row and marks it read', async () => {
    const r = await render(<NotificationsScreen />);
    await TestRenderer.act(async () => {
      hosts(r, 'notification-approval-ap-row-allow_once')[0].props.onPress();
    });
    await flush();
    expect(testState.api.answerApproval).toHaveBeenCalledWith('ap1', 'allow_once');
    expect(hosts(r, 'notification-approval-ap-row')).toHaveLength(0);
    expect(testState.api.notifications.markRead).toHaveBeenCalledWith('ap-row');
  });
});
