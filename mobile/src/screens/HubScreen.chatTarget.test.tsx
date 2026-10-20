import { describe, expect, it, vi } from 'vitest';
import type { HubChatChannel } from '@shared/utils/hubChat';

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  TouchableOpacity: 'TouchableOpacity',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (s: any) => s },
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('@react-navigation/native', () => ({ useFocusEffect: () => {} }));
vi.mock('../context/SidebarContext', async () => {
  const React = await import('react');
  return { SidebarContext: React.createContext(null) };
});
vi.mock('../context/AppContext', () => ({
  useApp: () => ({
    setActiveAgentId: () => {},
    setActiveSessionId: () => {},
    setSessionEngine: () => {},
    setSessionModel: () => {},
    setHubSessionId: () => {},
    setHubFocused: () => {},
    clearHubChat: () => {},
  }),
}));
const api = vi.hoisted(() => ({
  getHubSession: vi.fn().mockResolvedValue({}),
  hubChat: { channels: vi.fn(), openSummaryChannel: vi.fn() },
}));
vi.mock('../utils/api', () => ({ api }));
vi.mock('../utils/hubChatInstance', async () => {
  const { createHubChatStore } = await import('../utils/hubChatStore');
  return { hubChatStore: createHubChatStore(api.hubChat) };
});
vi.mock('../components/HubIcon', () => ({ default: () => null }));
vi.mock('../components/BrandLogo', () => ({ default: () => null }));
// Dashboard surfaces its shortcut navigation so tests can tap one.
const dashboard = vi.hoisted(() => ({ navigation: null as any }));
vi.mock('./DashboardHomeScreen', () => ({
  default: (props: any) => {
    dashboard.navigation = props.navigation;
    return 'pane:dashboard';
  },
}));
vi.mock('./TodosScreen', () => ({ default: () => 'pane:todos' }));
vi.mock('./CalendarScreen', () => ({ default: () => 'pane:calendar' }));
vi.mock('./GmailScreen', () => ({ default: () => 'pane:mail' }));
for (const m of ['./DashboardScreen', './SupportOverviewScreen', './ChatScreen']) {
  vi.doMock(m, () => ({ default: () => null }));
}
// The chat screen stub surfaces the channel the Hub hands it.
vi.mock('./HubChatScreen', () => ({
  default: (props: any) => `chat:${props.initialChannelId ?? 'none'}`,
  CountBadge: () => null,
}));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = await import('react-test-renderer');
const { default: HubScreen } = await import('./HubScreen');
const { hubChatStore } = await import('../utils/hubChatInstance');
process.env.NODE_ENV = originalNodeEnv;

const channel = { id: 'c1' } as HubChatChannel;
const showPane = (r: any, navigation: any, pane: string) =>
  act(async () => {
    r.update(
      React.createElement(HubScreen, {
        navigation,
        route: { params: { pane } },
      }),
    );
  });
const shownChat = (r: any) => JSON.stringify(r.toJSON()).match(/chat:([^"]+)/)?.[1] ?? null;

describe('HubScreen panes', () => {
  it('does not render a tab strip', async () => {
    let r: any;
    await act(async () => {
      r = TestRenderer.create(
        React.createElement(HubScreen, {
          navigation: { setParams: vi.fn() },
          route: { params: {} },
        }),
      );
    });
    expect(r.root.findAll((n: any) => n.props?.testID === 'hub-tabs')).toHaveLength(0);
    expect(r.root.findAll((n: any) => n.props?.testID === 'hub-tab-assistant')).toHaveLength(0);
    expect(r.root.findAll((n: any) => n.props?.testID === 'hub-tab-support')).toHaveLength(0);
  });
});

// Mimics the native stack: navigate() to the current screen and setParams()
// both merge into the same route's params instead of pushing a new screen.
function StackHost({ initialParams }: { initialParams: any }) {
  const [params, setParams] = React.useState<any>(initialParams);
  const navigation = React.useMemo(
    () => ({
      setParams: (p: any) => setParams((prev: any) => ({ ...prev, ...p })),
      navigate: (_name: string, p?: any) => setParams((prev: any) => ({ ...prev, ...p })),
    }),
    [],
  );
  (StackHost as any).navigation = navigation;
  return React.createElement(HubScreen, { navigation, route: { params } });
}
const shownPane = (r: any) => JSON.stringify(r.toJSON()).match(/pane:([a-z]+)/)?.[1] ?? null;

describe('HubScreen route stays in sync with the shown pane', () => {
  it.each([
    ['Todos', 'todos'],
    ['Calendar', 'calendar'],
    ['Gmail', 'mail'],
  ])('reopens Dashboard from the drawer after the %s shortcut', async (target, pane) => {
    let r: any;
    await act(async () => {
      r = TestRenderer.create(React.createElement(StackHost, { initialParams: { pane: 'today' } }));
    });
    expect(shownPane(r)).toBe('dashboard');
    await act(async () => {
      dashboard.navigation.navigate(target);
    });
    expect(shownPane(r)).toBe(pane);
    // The drawer's Dashboard row.
    await act(async () => {
      (StackHost as any).navigation.navigate('Hub', { pane: 'today', tab: undefined });
    });
    expect(shownPane(r)).toBe('dashboard');
    act(() => r.unmount());
  });
});

describe('HubScreen retained chat channel', () => {
  it('drops the retained channel when the account changes while Chat is closed', async () => {
    api.hubChat.channels.mockResolvedValue({ channels: [channel], viewerUserId: 'u1' });
    await hubChatStore.reset(true, 'u1');
    let r: any;
    const navigation = { setParams: vi.fn(), navigate: vi.fn() };
    await act(async () => {
      r = TestRenderer.create(
        React.createElement(HubScreen, { navigation, route: { params: { channelId: 'c1' } } }),
      );
    });
    expect(shownChat(r)).toBe('c1');
    await showPane(r, navigation, 'today'); // Chat unmounts
    api.hubChat.channels.mockResolvedValue({ channels: [], viewerUserId: 'u2' });
    await act(async () => {
      await hubChatStore.reset(true, 'u2');
    });
    await showPane(r, navigation, 'chat');
    expect(shownChat(r)).toBe('none');
    act(() => r.unmount());
  });

  it('keeps a channel a push asked for while no account was active yet', async () => {
    // Cold start: not signed in / not connected yet.
    await act(async () => {
      void hubChatStore.reset(false, null);
    });
    let r: any;
    await act(async () => {
      r = TestRenderer.create(
        React.createElement(HubScreen, {
          navigation: { setParams: vi.fn(), navigate: vi.fn() },
          route: { params: { channelId: 'c9' } },
        }),
      );
    });
    api.hubChat.channels.mockResolvedValue({ channels: [], viewerUserId: 'u1' });
    await act(async () => {
      await hubChatStore.reset(true, 'u1');
    });
    expect(shownChat(r)).toBe('c9');
    act(() => r.unmount());
  });

  it('opens the Summaries channel from an old Daily Summary tab link', async () => {
    api.hubChat.channels.mockResolvedValue({ channels: [], viewerUserId: 'u1' });
    api.hubChat.openSummaryChannel.mockResolvedValue({ channel: { id: 'sum-1' } });
    await hubChatStore.reset(true, 'u1');
    const setParams = vi.fn();
    let r: any;
    await act(async () => {
      r = TestRenderer.create(
        React.createElement(HubScreen, {
          navigation: { setParams, navigate: vi.fn() },
          route: { params: { tab: 'summary' } },
        }),
      );
    });
    expect(api.hubChat.openSummaryChannel).toHaveBeenCalledTimes(1);
    expect(setParams).toHaveBeenCalledWith({ tab: 'chat', pane: undefined });
    expect(shownChat(r)).toBe('sum-1');
    expect(r.root.findAll((n: any) => n.props?.testID === 'hub-tab-summary')).toHaveLength(0);
    act(() => r.unmount());
  });
});
