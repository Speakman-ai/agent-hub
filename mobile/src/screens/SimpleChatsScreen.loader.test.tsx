import type { ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Opening a consult chat for another agent goes through the real AppContext
 * sessions loader. That loader picks the newest row unless a target is
 * pinned, so the roster must pin its chosen consult chat or a newer build
 * session opens inside the consult-only shell.
 */

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = TestRenderer;

const storage = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    getItem: vi.fn(async (key: string) => (store.has(key) ? store.get(key)! : null)),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    multiGet: vi.fn(async (keys: string[]) => keys.map((key) => [key, store.get(key) ?? null])),
    multiSet: vi.fn(async () => {}),
    multiRemove: vi.fn(async () => {}),
    getAllKeys: vi.fn(async () => [...store.keys()]),
    clear: vi.fn(async () => store.clear()),
  };
});
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  View: 'View',
  Text: 'Text',
  TextInput: 'TextInput',
  Pressable: 'Pressable',
  TouchableOpacity: 'TouchableOpacity',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: any) => styles, hairlineWidth: 1 },
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('../components/BrandLogo', () => ({ default: () => null }));
vi.mock('../utils/serverAgentInstance', () => ({
  useServerAgentSettings: () => null,
  serverAgentDisplayName: () => 'Server Agent',
}));
const navigation = vi.hoisted(() => ({ navigate: vi.fn(), focused: true }));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => navigation,
  useIsFocused: () => navigation.focused,
}));
vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: () => ({ send: vi.fn(), connected: true, reconnecting: false, reconnect: vi.fn() }),
}));
vi.mock('../utils/config', () => ({
  loadConnectionConfig: vi.fn(async () => {}),
  saveConnectionConfig: vi.fn(async () => {}),
  getApiBaseUrl: () => 'http://hub.test',
  getServerBaseUrl: () => 'http://hub.test',
}));
vi.mock('../utils/orgs', () => ({
  loadOrgs: vi.fn(),
  migrateFromLegacy: vi.fn(async () => {}),
  getOrgs: () => ({ orgs: [] }),
  getActiveOrg: () => null,
}));
vi.mock('../utils/auth', () => ({
  loadAuthToken: vi.fn(async () => {}),
  isAuthenticated: () => true,
  getAuthStatus: vi.fn(async () => ({})),
  getAuthRecord: () => null,
  needsEmailUpdate: () => false,
  onDeadSession: () => () => {},
}));
vi.mock('../utils/setupState', () => ({
  loadSetupDismissed: vi.fn(async () => true),
  saveSetupDismissed: vi.fn(),
  shouldShowWizard: () => false,
  shouldGateLoginAfterSetup: () => false,
  shouldGateAuthFromStatus: () => false,
}));
vi.mock('../utils/push', () => ({
  registerForPushNotifications: vi.fn(),
  presentLocalNotification: vi.fn(),
}));
vi.mock('../utils/uploadAttachments', () => ({ uploadAttachments: vi.fn() }));

const SESSIONS: Record<string, any[]> = {
  cam: [{ id: 'cam-chat', agent_id: 'cam', session_mode: 'consult' }],
  ada: [
    // Newest first, the order the server returns.
    { id: 'ada-build', agent_id: 'ada', session_mode: null, updated_at: '2026-11-02T10:00:00Z' },
    {
      id: 'ada-chat',
      agent_id: 'ada',
      session_mode: 'consult',
      updated_at: '2026-11-01T10:00:00Z',
    },
  ],
};
const AGENTS = [
  { id: 'cam', name: 'Cam', role: 'dev', projectId: 'p', active: true, engine: 'claude-code' },
  { id: 'ada', name: 'Ada', role: 'dev', projectId: 'p', active: true, engine: 'claude-code' },
];
vi.mock('../utils/api', () => {
  const known: Record<string, (...args: any[]) => Promise<any>> = {
    getAgents: async () => AGENTS,
    getProjects: async () => [{ id: 'p', name: 'Hub' }],
    getSessions: async (agentId: string) => SESSIONS[agentId] ?? [],
    getArchivedSessions: async () => [],
    getCronSessions: async () => [],
    getMessages: async () => [],
    getSessionHandoffs: async () => [],
    getSkills: async () => [],
  };
  return {
    api: new Proxy(known, {
      get: (target, key: string) => target[key] ?? (() => Promise.resolve({})),
    }),
  };
});

const { AppProvider, useApp } = await import('../context/AppContext');
const { default: SimpleChatsScreen } = await import('./SimpleChatsScreen');

const Text = 'Text' as any;
function Probe() {
  const app = useApp();
  return (
    <Text testID="probe">{`agent=${app.activeAgentId ?? ''};session=${app.activeSessionId ?? ''}`}</Text>
  );
}
function probe(renderer: ReactTestRenderer): string {
  return [].concat(renderer.root.findByProps({ testID: 'probe' }).props.children).join('');
}
async function flush() {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('SimpleChatsScreen with the real sessions loader', () => {
  let renderer: ReactTestRenderer;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storage.store.clear();
    navigation.navigate.mockClear();
  });
  afterEach(async () => {
    if (renderer) await act(async () => renderer.unmount());
    vi.unstubAllGlobals();
  });

  it('keeps the chosen consult chat when the agent has a newer build session', async () => {
    storage.store.set('agenthub.simpleSession:ada', 'ada-chat');
    await act(async () => {
      renderer = TestRenderer.create(
        <AppProvider>
          <SimpleChatsScreen />
          <Probe />
        </AppProvider>,
      );
    });
    await flush();
    expect(probe(renderer)).toBe('agent=cam;session=cam-chat');

    await act(async () => {
      renderer.root.findByProps({ testID: 'simple-agent-ada' }).props.onPress();
    });
    await flush();

    expect(navigation.navigate).toHaveBeenCalledWith('SimpleChat', {
      kind: 'agent',
      agentId: 'ada',
      sessionId: 'ada-chat',
    });
    expect(probe(renderer)).toBe('agent=ada;session=ada-chat');
  });
});
