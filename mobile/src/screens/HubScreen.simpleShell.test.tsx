import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  TouchableOpacity: 'TouchableOpacity',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (s: any) => s },
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('@react-navigation/native', async () => {
  const React = await import('react');
  return {
    useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(effect, [effect]),
  };
});
const storage = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
});
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));
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
  }),
}));
vi.mock('../utils/api', () => ({
  api: { getHubSession: vi.fn().mockResolvedValue({}), hubChat: { openSummaryChannel: vi.fn() } },
}));
vi.mock('../hooks/useHubChat', async () => {
  const React = await import('react');
  return { useAccountScoped: (initial: any) => React.useState(initial) };
});
vi.mock('../hooks/useGoogleChatAvailable', () => ({ useGoogleChatAvailable: () => false }));
vi.mock('../components/HubIcon', () => ({ default: () => null }));
vi.mock('../components/BrandLogo', () => ({ default: () => null }));
vi.mock('./TodosScreen', () => ({ default: () => 'pane:todos' }));
vi.mock('./GmailScreen', () => ({ default: () => 'pane:mail' }));
for (const m of [
  './DashboardHomeScreen',
  './DashboardScreen',
  './RemindersScreen',
  './CalendarScreen',
  './SupportOverviewScreen',
  './HubChatScreen',
  './GoogleChatScreen',
]) {
  vi.doMock(m, () => ({ default: () => null }));
}
vi.mock('./ServerAgentScreen', () => ({
  ServerAgentScreen: () => null,
  ServerAgentSettingsScreen: () => null,
}));

const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = await import('react-test-renderer');
const { default: HubScreen } = await import('./HubScreen');
const { SHELL_MODE_KEY, readShellMode } = await import('../utils/simpleShell');
process.env.NODE_ENV = originalNodeEnv;

async function renderHub(mode: 'hub' | 'simple', pane: string) {
  storage.store.set(SHELL_MODE_KEY, mode);
  await readShellMode();
  const navigation = { setParams: vi.fn(), navigate: vi.fn() };
  let r: any;
  await act(async () => {
    r = TestRenderer.create(
      React.createElement(HubScreen, { navigation, route: { params: { pane } } }),
    );
  });
  return { r, navigation };
}

const byId = (r: any, testID: string) => r.root.findAll((n: any) => n.props?.testID === testID);
const shownPane = (r: any) => JSON.stringify(r.toJSON()).match(/pane:([a-z]+)/)?.[1] ?? null;

describe('HubScreen in the simple shell', () => {
  it('keeps the simple toolbar on a pane opened from it and highlights that pane', async () => {
    const { r } = await renderHub('simple', 'mail');
    expect(byId(r, 'simple-home-nav')).toHaveLength(1);
    expect(r.root.findAllByProps({ accessibilityLabel: 'Open menu' })).toHaveLength(0);
    expect(byId(r, 'simple-home-mail')[0].props.accessibilityState).toEqual({ selected: true });
    expect(byId(r, 'simple-home-chats')[0].props.accessibilityState).toEqual({ selected: false });
    act(() => r.unmount());
  });

  it('switches panes in place and returns to the chat list from Chats', async () => {
    const { r, navigation } = await renderHub('simple', 'mail');
    await act(async () => {
      byId(r, 'simple-home-todos')[0].props.onPress();
    });
    expect(shownPane(r)).toBe('todos');
    expect(byId(r, 'simple-home-todos')[0].props.accessibilityState).toEqual({ selected: true });
    await act(async () => {
      byId(r, 'simple-home-chats')[0].props.onPress();
    });
    expect(navigation.navigate).toHaveBeenCalledWith('Simple');
    act(() => r.unmount());
  });

  it('shows the full Hub header outside the simple shell', async () => {
    const { r } = await renderHub('hub', 'mail');
    expect(byId(r, 'simple-home-nav')).toHaveLength(0);
    expect(r.root.findAllByProps({ accessibilityLabel: 'Open menu' }).length).toBeGreaterThan(0);
    act(() => r.unmount());
  });
});
