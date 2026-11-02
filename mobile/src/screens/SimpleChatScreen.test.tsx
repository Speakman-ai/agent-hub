import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('../components/BrandLogo', () => ({ default: () => 'brand-mark' }));
vi.mock('../utils/serverAgentInstance', () => ({
  useServerAgentSettings: () => null,
  serverAgentDisplayName: () => 'Server Agent',
}));

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
  };
});
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));

const chat = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock('./ChatScreen', () => ({
  default: (props: Record<string, unknown>) => {
    chat.props = props;
    return 'chat';
  },
}));

const nav = vi.hoisted(() => ({
  navigate: vi.fn(),
  params: { kind: 'server', agentId: 'ada' } as {
    kind: string;
    agentId?: string;
    sessionId?: string;
  },
  focused: true,
}));
// Mirrors React Navigation: the effect runs on focus and cleans up on blur.
vi.mock('@react-navigation/native', async () => {
  const { useEffect } = await import('react');
  return {
    useNavigation: () => nav,
    useRoute: () => ({ params: nav.params }),
    useFocusEffect: (effect: () => undefined | (() => void)) => {
      const focused = nav.focused;
      useEffect(() => (focused ? effect() : undefined), [focused, effect]);
    },
    useIsFocused: () => nav.focused,
  };
});

const app = vi.hoisted(() => ({
  agents: [{ id: 'ada', name: 'Ada' }],
  sessions: [] as Array<Record<string, unknown>>,
  activeSessionId: null as string | null,
  activeAgentId: null as string | null,
  clearHubChat: vi.fn(),
  handleOpenHandoffSession: vi.fn(),
  setActiveAgentId: vi.fn(),
  setActiveSessionId: vi.fn(),
  setHubFocused: vi.fn(),
  setHubSessionId: vi.fn(),
  setSessionEngine: vi.fn(),
  setSessionModel: vi.fn(),
}));
vi.mock('../context/AppContext', () => ({ useApp: () => app }));

const api = vi.hoisted(() => ({
  getHubSession: vi.fn(async () => ({
    agent: { id: '__hub_assistant__' },
    session: { id: 'hub-9', engine: 'claude-code', model: 'opus' },
  })),
}));
vi.mock('../utils/api', () => ({ api }));

process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = TestRenderer;
const { default: SimpleChatScreen } = await import('./SimpleChatScreen');

describe('SimpleChatScreen', () => {
  it('opens the Server Agent chat with the hub mark and a clear action', async () => {
    nav.params = { kind: 'server' };
    chat.props = null;
    await act(async () => {
      TestRenderer.create(React.createElement(SimpleChatScreen));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(chat.props).toMatchObject({
      embedded: true,
      simple: true,
      simpleServer: true,
    });
    const props = chat.props as unknown as Record<string, unknown>;
    expect(typeof props.onClearChat).toBe('function');
    expect(app.setHubSessionId).toHaveBeenCalledWith('hub-9');
    expect(app.setHubFocused).toHaveBeenCalledWith(true);
  });

  it('opens a project chat without the hub send path', async () => {
    nav.params = { kind: 'agent', agentId: 'ada' };
    api.getHubSession.mockClear();
    await act(async () => {
      TestRenderer.create(React.createElement(SimpleChatScreen));
    });
    const props = chat.props as unknown as Record<string, unknown>;
    expect(props).toMatchObject({
      simple: true,
      simpleServer: false,
      emptyHint: 'Ask Ada anything.',
    });
    expect(props.onClearChat).toBeUndefined();
    expect(api.getHubSession).not.toHaveBeenCalled();
  });

  it('opens a session linked from the transcript in the full chat', async () => {
    nav.params = { kind: 'server' };
    nav.navigate.mockClear();
    storage.store.clear();
    await act(async () => {
      TestRenderer.create(React.createElement(SimpleChatScreen));
    });
    const props = chat.props as unknown as {
      onOpenSession: (agentId: string, sessionId: string) => void;
    };
    await act(async () => {
      props.onOpenSession('ada', 'build-1');
    });
    expect(app.handleOpenHandoffSession).toHaveBeenCalledWith('ada', 'build-1');
    expect(nav.navigate).toHaveBeenCalledWith('Chat');
    expect(storage.store.get('agenthub.shellMode')).toBe('hub');
  });

  it('leaves for the full chat when a build session is active in a project chat', async () => {
    nav.params = { kind: 'agent', agentId: 'ada' };
    nav.navigate.mockClear();
    storage.store.clear();
    app.sessions = [
      { id: 'build-1', session_mode: null },
      { id: 'ada-chat', session_mode: 'consult' },
    ];
    app.activeSessionId = 'build-1';
    await act(async () => {
      TestRenderer.create(React.createElement(SimpleChatScreen));
    });
    expect(nav.navigate).toHaveBeenCalledWith('Chat');
    expect(storage.store.get('agenthub.shellMode')).toBe('hub');

    nav.navigate.mockClear();
    app.activeSessionId = 'ada-chat';
    await act(async () => {
      TestRenderer.create(React.createElement(SimpleChatScreen));
    });
    expect(nav.navigate).not.toHaveBeenCalled();
    app.sessions = [];
    app.activeSessionId = null;
  });

  it('takes the Hub session back each time the retained Server Agent screen regains focus', async () => {
    nav.params = { kind: 'server' };
    nav.focused = true;
    app.setActiveSessionId.mockClear();
    app.setHubFocused.mockClear();
    let renderer: ReturnType<typeof TestRenderer.create> | undefined;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(SimpleChatScreen));
    });
    expect(app.setActiveSessionId).toHaveBeenLastCalledWith('hub-9');

    // A transcript link opened a project session in Chat; this screen blurs
    // but stays mounted, and a Hub response still in flight must not land.
    let releaseHub: (body: unknown) => void = () => {};
    api.getHubSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseHub = resolve;
        }) as never,
    );
    nav.focused = false;
    await act(async () => {
      renderer!.update(React.createElement(SimpleChatScreen));
    });
    expect(app.setHubFocused).toHaveBeenLastCalledWith(false);
    app.setActiveSessionId('project-build');
    app.setActiveSessionId.mockClear();

    nav.focused = true;
    await act(async () => {
      renderer!.update(React.createElement(SimpleChatScreen));
    });
    nav.focused = false;
    await act(async () => {
      renderer!.update(React.createElement(SimpleChatScreen));
    });
    await act(async () => {
      releaseHub({ session: { id: 'hub-stale' } });
      await Promise.resolve();
    });
    expect(app.setActiveSessionId).not.toHaveBeenCalledWith('hub-stale');

    nav.focused = true;
    await act(async () => {
      renderer!.update(React.createElement(SimpleChatScreen));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(app.setActiveSessionId).toHaveBeenLastCalledWith('hub-9');
    expect(app.setHubFocused).toHaveBeenLastCalledWith(true);
  });

  it('takes its consult chat back when a retained project chat regains focus', async () => {
    nav.params = { kind: 'agent', agentId: 'ada', sessionId: 'ada-chat' };
    nav.focused = true;
    nav.navigate.mockClear();
    app.handleOpenHandoffSession.mockClear();
    app.setActiveSessionId.mockClear();
    app.sessions = [
      { id: 'build-1', session_mode: null },
      { id: 'ada-chat', session_mode: 'consult' },
    ];
    app.activeAgentId = 'ada';
    app.activeSessionId = 'ada-chat';
    let renderer: ReturnType<typeof TestRenderer.create> | undefined;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(SimpleChatScreen));
    });

    // A build link opened Chat; this screen blurred but stayed mounted.
    nav.focused = false;
    await act(async () => {
      renderer!.update(React.createElement(SimpleChatScreen));
    });
    app.activeSessionId = 'build-1';
    storage.store.set('agenthub.shellMode', 'hub');

    // Native Back: focus returns with the build still selected globally.
    nav.focused = true;
    app.setActiveSessionId.mockClear();
    await act(async () => {
      renderer!.update(React.createElement(SimpleChatScreen));
    });
    expect(app.setActiveSessionId).toHaveBeenCalledWith('ada-chat');
    expect(nav.navigate).not.toHaveBeenCalledWith('Chat');
    expect(storage.store.get('agenthub.shellMode')).toBe('simple');

    // Returning while another agent is active pins the loader to this chat.
    nav.focused = false;
    await act(async () => {
      renderer!.update(React.createElement(SimpleChatScreen));
    });
    app.activeAgentId = 'cam';
    app.activeSessionId = 'cam-chat';
    nav.focused = true;
    await act(async () => {
      renderer!.update(React.createElement(SimpleChatScreen));
    });
    expect(app.handleOpenHandoffSession).toHaveBeenCalledWith('ada', 'ada-chat');

    // Once bound, a build that replaces the chat still leaves for Chat.
    app.activeAgentId = 'ada';
    app.activeSessionId = 'ada-chat';
    await act(async () => {
      renderer!.update(React.createElement(SimpleChatScreen));
    });
    app.activeSessionId = 'build-1';
    await act(async () => {
      renderer!.update(React.createElement(SimpleChatScreen));
    });
    expect(nav.navigate).toHaveBeenCalledWith('Chat');
    app.sessions = [];
    app.activeSessionId = null;
    app.activeAgentId = null;
  });
});
