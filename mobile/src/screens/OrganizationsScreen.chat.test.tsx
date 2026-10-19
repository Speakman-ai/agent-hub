import type { ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = TestRenderer;

const ctl = vi.hoisted(() => ({
  onMessage: null as null | ((data: any) => void),
  openChat: null as null | ((target: any) => void),
  panelProps: null as any,
}));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  View: 'View',
  Text: 'Text',
  TextInput: 'TextInput',
  TouchableOpacity: 'TouchableOpacity',
  ScrollView: 'ScrollView',
  Switch: 'Switch',
  StyleSheet: { create: (styles: any) => styles, hairlineWidth: 1 },
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('../components/ProjectScreenHeader', () => ({ default: () => null }));
vi.mock('../components/OrganizationsPanel', () => ({
  default: (props: any) => {
    ctl.openChat = props.onOpenChat;
    ctl.panelProps = props;
    return null;
  },
}));
vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: (handler: (data: any) => void) => {
    ctl.onMessage = handler;
    return { send: vi.fn(), connected: true, reconnecting: false, reconnect: vi.fn() };
  },
}));
vi.mock('../utils/config', () => ({
  loadConnectionConfig: () => new Promise(() => {}),
  getApiBaseUrl: () => '',
}));
vi.mock('../utils/orgs', () => ({
  loadOrgs: vi.fn(),
  migrateFromLegacy: vi.fn(),
  getOrgs: () => ({ orgs: [] }),
  getActiveOrg: () => ({ id: 'server-a' }),
}));
vi.mock('../utils/auth', () => ({
  loadAuthToken: vi.fn(),
  isAuthenticated: () => false,
  getAuthStatus: vi.fn(),
  getAuthRecord: () => null,
  needsEmailUpdate: () => false,
  onDeadSession: () => () => {},
}));
vi.mock('../utils/setupState', () => ({
  loadSetupDismissed: vi.fn(),
  saveSetupDismissed: vi.fn(),
  shouldShowWizard: vi.fn(),
  shouldGateLoginAfterSetup: vi.fn(),
  shouldGateAuthFromStatus: vi.fn(),
}));
vi.mock('../utils/push', () => ({
  registerForPushNotifications: vi.fn(),
  presentLocalNotification: vi.fn(),
}));
vi.mock('../utils/uploadAttachments', () => ({ uploadAttachments: vi.fn() }));
// Every other API read the provider makes resolves empty; nothing reaches a server.
vi.mock('../utils/api', () => ({
  api: new Proxy({}, { get: () => () => Promise.resolve({}) }),
}));

const { AppProvider, useApp } = await import('../context/AppContext');
const { default: OrganizationsScreen } = await import('./OrganizationsScreen');

const agent = (organization: string, name: string) => ({
  id: `__organization_${organization}__agent`,
  name,
  engine: 'claude-code',
  organizationScope: { enabled: true, archivedAt: null, projects: 'all-linked', tools: [] },
});
function Probe() {
  const app = useApp();
  return (
    <Text>
      {`agent=${app.activeAgent?.name ?? ''};session=${app.activeSessionId ?? ''};stream=${app.streamingContent ?? ''}`}
    </Text>
  );
}
const Text = 'Text' as any;
function probe(renderer: ReactTestRenderer): string {
  const found = renderer.root.findAll((n: any) => n.type === 'Text');
  return found.map((n: any) => [].concat(n.props.children).join('')).join(' ');
}

describe('mobile organization chat', () => {
  let renderer: ReactTestRenderer;
  const navigation = { navigate: vi.fn(), goBack: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });
  afterEach(async () => {
    if (renderer) await act(async () => renderer.unmount());
    vi.unstubAllGlobals();
  });

  it('opens the shared chat as the organization agent and streams only that session', async () => {
    await act(async () => {
      renderer = TestRenderer.create(
        <AppProvider>
          <OrganizationsScreen navigation={navigation} />
          <Probe />
        </AppProvider>,
      );
    });
    const first = agent('one', 'Marketing');
    await act(async () => {
      ctl.openChat!({ organizationId: 'one', agentId: first.id, sessionId: 's1', agent: first });
    });
    expect(navigation.navigate).toHaveBeenCalledWith('Chat');
    expect(probe(renderer)).toContain('agent=Marketing;session=s1;');

    const stream = (sessionId: string, content: string) =>
      act(async () => {
        ctl.onMessage!({ type: 'thinking', sessionId, messageId: `m-${sessionId}` });
        ctl.onMessage!({ type: 'stream', sessionId, messageId: `m-${sessionId}`, content });
      });
    await stream('elsewhere', 'other chat text');
    expect(probe(renderer)).not.toContain('other chat text');
    await stream('s1', 'live reply');
    expect(probe(renderer)).toContain('stream=live reply');

    const second = agent('two', 'Finance');
    await act(async () => {
      ctl.openChat!({ organizationId: 'two', agentId: second.id, sessionId: 's2', agent: second });
    });
    const text = probe(renderer);
    expect(text).toContain('agent=Finance;session=s2;');
    expect(text).not.toContain('live reply');
  });

  it('names the open organization chat Computer owner and swaps it on organization switch', async () => {
    function OwnerProbe() {
      const app = useApp();
      return <Text>{`owner=${app.organizationComputerOwner ?? ''}`}</Text>;
    }
    await act(async () => {
      renderer = TestRenderer.create(
        <AppProvider>
          <OrganizationsScreen navigation={navigation} />
          <OwnerProbe />
        </AppProvider>,
      );
    });
    const first = agent('one', 'Assistant');
    await act(async () => {
      ctl.openChat!({
        organizationId: 'one',
        organizationName: 'Acme',
        agentId: first.id,
        sessionId: 's1',
        agent: first,
      });
    });
    expect(probe(renderer)).toContain('owner=Assistant in Acme · private to you');
    const second = agent('two', 'Finance');
    await act(async () => {
      ctl.openChat!({
        organizationId: 'two',
        organizationName: 'Globex',
        agentId: second.id,
        sessionId: 's2',
        agent: second,
      });
    });
    const text = probe(renderer);
    expect(text).toContain('owner=Finance in Globex · private to you');
    expect(text).not.toContain('Acme');
  });

  it('selects a linked organization only on the Server the link names', async () => {
    for (const [serverId, expected] of [
      ['server-a', 'o1'],
      ['server-b', null],
    ] as const) {
      await act(async () => {
        renderer = TestRenderer.create(
          <AppProvider>
            <OrganizationsScreen
              navigation={navigation}
              route={{ params: { organizationId: 'o1', serverId } }}
            />
          </AppProvider>,
        );
      });
      expect(ctl.panelProps.initialOrganizationId).toBe(expected);
      await act(async () => renderer.unmount());
    }
  });

  it('routes portfolio drill-downs to the project board and the dispatched session', async () => {
    await act(async () => {
      renderer = TestRenderer.create(
        <AppProvider>
          <OrganizationsScreen navigation={navigation} />
          <Probe />
        </AppProvider>,
      );
    });
    await act(async () => ctl.panelProps.onOpenProject('alpha'));
    expect(navigation.navigate).toHaveBeenCalledWith('Kanban', {
      projectId: 'alpha',
      project: undefined,
    });
    await act(async () => ctl.panelProps.onOpenSession('alpha-dev', 'target-1'));
    expect(navigation.navigate).toHaveBeenLastCalledWith('Chat');
    expect(probe(renderer)).toContain('session=target-1;');
  });

  function focusableNavigation() {
    const handlers: Record<string, () => void> = {};
    return {
      handlers,
      navigation: {
        ...navigation,
        addListener: vi.fn((event: string, handler: () => void) => {
          handlers[event] = handler;
          return () => undefined;
        }),
      },
    };
  }

  it('reloads on the first return when the screen was already focused at mount', async () => {
    const { handlers, navigation: focusable } = focusableNavigation();
    await act(async () => {
      renderer = TestRenderer.create(
        <AppProvider>
          <OrganizationsScreen navigation={focusable} />
        </AppProvider>,
      );
    });
    // No initial focus event: the screen was focused before the listener subscribed.
    const before = ctl.panelProps.refreshKey;
    await act(async () => handlers.blur()); // Chat opens on top
    await act(async () => handlers.focus()); // back from Chat
    expect(ctl.panelProps.refreshKey).not.toBe(before);
  });

  it('does not reload for a focus event that is not a return', async () => {
    const { handlers, navigation: focusable } = focusableNavigation();
    await act(async () => {
      renderer = TestRenderer.create(
        <AppProvider>
          <OrganizationsScreen navigation={focusable} />
        </AppProvider>,
      );
    });
    const before = ctl.panelProps.refreshKey;
    await act(async () => handlers.focus()); // initial focus delivered after subscribing
    expect(ctl.panelProps.refreshKey).toBe(before);
    await act(async () => handlers.blur());
    await act(async () => handlers.focus());
    expect(ctl.panelProps.refreshKey).not.toBe(before);
  });
});
