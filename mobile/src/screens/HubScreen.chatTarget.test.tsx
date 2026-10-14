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
  hubChat: { channels: vi.fn() },
}));
vi.mock('../utils/api', () => ({ api }));
vi.mock('../utils/hubChatInstance', async () => {
  const { createHubChatStore } = await import('../utils/hubChatStore');
  return { hubChatStore: createHubChatStore(api.hubChat) };
});
vi.mock('../components/HubIcon', () => ({ default: () => null }));
vi.mock('../components/BrandLogo', () => ({ default: () => null }));
for (const m of [
  './DashboardHomeScreen',
  './DailySummaryScreen',
  './DashboardScreen',
  './TodosScreen',
  './CalendarScreen',
  './GmailScreen',
  './SupportOverviewScreen',
  './ChatScreen',
]) {
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
const tab = (r: any, id: string) =>
  act(async () => {
    r.root.find((n: any) => n.props?.testID === `hub-tab-${id}`).props.onPress();
  });
const shownChat = (r: any) => JSON.stringify(r.toJSON()).match(/chat:([^"]+)/)?.[1] ?? null;

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
    await tab(r, 'today'); // Chat unmounts
    api.hubChat.channels.mockResolvedValue({ channels: [], viewerUserId: 'u2' });
    await act(async () => {
      await hubChatStore.reset(true, 'u2');
    });
    await tab(r, 'chat');
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

  it('opens the Summaries channel from the Daily Summary history link', async () => {
    api.hubChat.channels.mockResolvedValue({ channels: [], viewerUserId: 'u1' });
    await hubChatStore.reset(true, 'u1');
    let r: any;
    await act(async () => {
      r = TestRenderer.create(
        React.createElement(HubScreen, {
          navigation: { setParams: vi.fn(), navigate: vi.fn() },
          route: { params: {} },
        }),
      );
    });
    await tab(r, 'summary');
    const summary = r.root.find((n: any) => typeof n.props?.onOpenChannel === 'function');
    await act(async () => {
      summary.props.onOpenChannel('sum-1');
    });
    expect(shownChat(r)).toBe('sum-1');
    act(() => r.unmount());
  });
});
