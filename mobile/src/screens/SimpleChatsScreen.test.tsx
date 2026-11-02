import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  TextInput: 'TextInput',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
  StyleSheet: { create: (styles: unknown) => styles },
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

const navigation = vi.hoisted(() => ({ navigate: vi.fn(), focused: true }));
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => navigation,
  useIsFocused: () => navigation.focused,
}));

const app = vi.hoisted(() => ({
  handleOpenHandoffSession: vi.fn(),
  setActiveSessionId: vi.fn(),
  agents: [
    { id: 'ada', name: 'Ada', role: 'dev', projectId: 'p', active: true, color: '#fff' },
    { id: 'cam', name: 'Cam', role: 'dev', projectId: 'p', active: true, color: '#000' },
    { id: 'rev', name: 'Reviewer', role: 'reviewer', projectId: 'p', active: true },
  ],
  projects: [{ id: 'p', name: 'Hub' }],
  sessions: [],
  activeTasks: {},
  finalizeStatusBySession: {},
  needsInputBySession: {},
  hubSessionId: 'hub-1',
  activeAgentId: null as string | null,
  activeSessionId: null as string | null,
}));
vi.mock('../context/AppContext', () => ({ useApp: () => app }));

const api = vi.hoisted(() => ({
  getSessions: vi.fn(async (agentId: string) => {
    if (agentId === 'ada') {
      return [
        { id: 'ada-chat', session_mode: 'consult', name: 'Hello', finalize_status: 'disputed' },
      ];
    }
    return [{ id: 'cam-chat', session_mode: 'consult', name: 'Notes' }];
  }),
  createSession: vi.fn(),
}));
vi.mock('../utils/api', () => ({ api }));

process.env.NODE_ENV = 'development';
const React = await import('react');
const TestRenderer = (await import('react-test-renderer')).default;
const { act } = TestRenderer;
const { default: SimpleChatsScreen } = await import('./SimpleChatsScreen');

async function renderList() {
  let renderer: ReturnType<typeof TestRenderer.create> | undefined;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(SimpleChatsScreen));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer!;
}

function rowIds(renderer: ReturnType<typeof TestRenderer.create>) {
  return renderer.root
    .findAll((node) => String(node.type) === 'Pressable' && typeof node.props?.testID === 'string')
    .map((node) => node.props.testID as string)
    .filter((id) => id === 'simple-server-agent' || /^simple-agent-[a-z]+$/.test(id));
}

describe('SimpleChatsScreen', () => {
  beforeEach(() => {
    storage.store.clear();
    navigation.navigate.mockClear();
    app.handleOpenHandoffSession.mockClear();
    app.setActiveSessionId.mockClear();
  });

  it('pins the Server Agent, hides the reviewer, and marks needs-you', async () => {
    const renderer = await renderList();
    expect(rowIds(renderer)).toEqual([
      'simple-server-agent',
      'simple-agent-ada',
      'simple-agent-cam',
    ]);
    expect(JSON.stringify(renderer.toJSON())).toContain('brand-mark');
    expect(renderer.root.findAllByProps({ testID: 'simple-agent-ada-needs-you' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ testID: 'simple-agent-cam-needs-you' })).toHaveLength(0);
  });

  it('moves a chat into the slot it is dropped on and keeps that order', async () => {
    const renderer = await renderList();
    await act(async () => {
      renderer.root.findByProps({ testID: 'simple-agent-ada' }).props.onLongPress();
    });
    await act(async () => {
      renderer.root.findByProps({ testID: 'simple-agent-cam' }).props.onPress();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(rowIds(renderer)).toEqual([
      'simple-server-agent',
      'simple-agent-cam',
      'simple-agent-ada',
    ]);
    expect(storage.store.get('agenthub.simpleRosterOrder')).toBe(JSON.stringify(['cam', 'ada']));
  });

  it('opens a remembered consult chat and leaves for the full Hub', async () => {
    const renderer = await renderList();
    await act(async () => {
      renderer.root.findByProps({ testID: 'simple-agent-ada' }).props.onPress();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(app.handleOpenHandoffSession).toHaveBeenCalledWith('ada', 'ada-chat');
    expect(navigation.navigate).toHaveBeenCalledWith('SimpleChat', {
      kind: 'agent',
      agentId: 'ada',
      sessionId: 'ada-chat',
    });
    expect(storage.store.get('agenthub.shellMode')).toBe('simple');

    await act(async () => {
      renderer.root.findByProps({ testID: 'simple-full-hub' }).props.onPress();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(navigation.navigate).toHaveBeenCalledWith('Hub');
    expect(storage.store.get('agenthub.shellMode')).toBe('hub');
  });

  it('shows a newly created first chat and its live status on the list', async () => {
    const original = api.getSessions.getMockImplementation()!;
    api.getSessions.mockImplementation(async (agentId: string) =>
      agentId === 'ada' ? [{ id: 'ada-chat', session_mode: 'consult', name: 'Hello' }] : [],
    );
    api.createSession.mockResolvedValueOnce({
      id: 'cam-new',
      session_mode: 'consult',
      name: 'Chat',
    });
    app.activeTasks = { 'cam-new': { messageId: 'm1' } };
    const renderer = await renderList();
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Working');

    await act(async () => {
      renderer.root.findByProps({ testID: 'simple-agent-cam' }).props.onPress();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.createSession).toHaveBeenCalledWith('cam', 'Chat', { consultMode: true });
    expect(JSON.stringify(renderer.toJSON())).toContain('Working');
    app.activeTasks = {};
    api.getSessions.mockImplementation(original);
  });

  it('reloads the chats when the list is focused again', async () => {
    const renderer = await renderList();
    const before = api.getSessions.mock.calls.length;
    navigation.focused = false;
    await act(async () => {
      renderer.update(React.createElement(SimpleChatsScreen));
    });
    navigation.focused = true;
    await act(async () => {
      renderer.update(React.createElement(SimpleChatsScreen));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.getSessions.mock.calls.length).toBeGreaterThan(before);
  });

  it('ignores a slow chat open once another chat was chosen', async () => {
    const original = api.getSessions.getMockImplementation()!;
    api.getSessions.mockImplementation(async (agentId: string) =>
      agentId === 'ada' ? [{ id: 'ada-chat', session_mode: 'consult', name: 'Hello' }] : [],
    );
    let resolveCreate: (row: unknown) => void = () => {};
    api.createSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const renderer = await renderList();
    await act(async () => {
      void renderer.root.findByProps({ testID: 'simple-agent-cam' }).props.onPress();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.createSession).toHaveBeenCalledWith('cam', 'Chat', { consultMode: true });

    await act(async () => {
      await renderer.root.findByProps({ testID: 'simple-agent-ada' }).props.onPress();
    });
    expect(app.handleOpenHandoffSession).toHaveBeenLastCalledWith('ada', 'ada-chat');

    await act(async () => {
      resolveCreate({ id: 'cam-new', session_mode: 'consult', name: 'Chat' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(app.handleOpenHandoffSession).not.toHaveBeenCalledWith('cam', 'cam-new');
    expect(storage.store.has('agenthub.simpleSession:cam')).toBe(false);
    expect(navigation.navigate).not.toHaveBeenCalledWith(
      'SimpleChat',
      expect.objectContaining({ agentId: 'cam' }),
    );
    api.getSessions.mockImplementation(original);
  });

  it('ignores a slow Server Agent open once Full Hub was chosen', async () => {
    const renderer = await renderList();
    let releaseSimpleWrite: () => void = () => {};
    storage.setItem.mockImplementationOnce(
      (key: string, value: string) =>
        new Promise<void>((resolve) => {
          releaseSimpleWrite = () => {
            storage.store.set(key, value);
            resolve();
          };
        }),
    );
    await act(async () => {
      void renderer.root.findByProps({ testID: 'simple-server-agent' }).props.onPress();
    });
    await act(async () => {
      await renderer.root.findByProps({ testID: 'simple-full-hub' }).props.onPress();
    });
    expect(navigation.navigate).toHaveBeenCalledWith('Hub');

    await act(async () => {
      releaseSimpleWrite();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(navigation.navigate).not.toHaveBeenCalledWith('SimpleChat', { kind: 'server' });
  });

  it('returns Full Hub to the session open when Simple was entered', async () => {
    storage.store.set(
      'agenthub.preSimpleTarget',
      JSON.stringify({ agentId: 'cam', sessionId: 'cam-build' }),
    );
    app.activeAgentId = '__hub_assistant__';
    const renderer = await renderList();
    await act(async () => {
      await renderer.root.findByProps({ testID: 'simple-full-hub' }).props.onPress();
    });
    expect(app.handleOpenHandoffSession).toHaveBeenCalledWith('cam', 'cam-build');
    expect(navigation.navigate).toHaveBeenCalledWith('Chat');
    expect(storage.store.has('agenthub.preSimpleTarget')).toBe(false);
    app.activeAgentId = null;
  });

  it('makes one consult chat for repeated taps while the first create is in flight', async () => {
    const original = api.getSessions.getMockImplementation()!;
    api.getSessions.mockImplementation(async (agentId: string) =>
      agentId === 'ada' ? [{ id: 'ada-chat', session_mode: 'consult', name: 'Hello' }] : [],
    );
    api.createSession.mockClear();
    let resolveCreate: (row: unknown) => void = () => {};
    api.createSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const renderer = await renderList();
    const row = () => renderer.root.findByProps({ testID: 'simple-agent-cam' });
    await act(async () => {
      void row().props.onPress();
    });
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      void row().props.onPress();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.createSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCreate({ id: 'cam-new', session_mode: 'consult', name: 'Chat' });
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
    expect(storage.store.get('agenthub.simpleSession:cam')).toBe('cam-new');
    expect(app.handleOpenHandoffSession).toHaveBeenCalledWith('cam', 'cam-new');
    api.getSessions.mockImplementation(original);
  });

  it('makes one consult chat when two taps overlap their list requests', async () => {
    const original = api.getSessions.getMockImplementation()!;
    api.getSessions.mockImplementation(async (agentId: string) =>
      agentId === 'ada' ? [{ id: 'ada-chat', session_mode: 'consult', name: 'Hello' }] : [],
    );
    const renderer = await renderList();
    // Both taps see an empty cache, and their list requests are held open.
    const lists: Array<(rows: unknown) => void> = [];
    api.getSessions.mockImplementation(
      () =>
        new Promise((resolve) => {
          lists.push(resolve);
        }) as never,
    );
    api.createSession.mockClear();
    api.createSession.mockImplementation(async () => ({
      id: `cam-${api.createSession.mock.calls.length}`,
      session_mode: 'consult',
      name: 'Chat',
    }));
    const row = () => renderer.root.findByProps({ testID: 'simple-agent-cam' });
    await act(async () => {
      void row().props.onPress();
    });
    await act(async () => {
      for (let i = 0; i < 3; i += 1) await Promise.resolve();
    });
    await act(async () => {
      void row().props.onPress();
    });
    await act(async () => {
      for (let i = 0; i < 3; i += 1) await Promise.resolve();
    });

    // The first list answers empty and its create finishes; then any second
    // list answers with its earlier empty snapshot.
    await act(async () => {
      lists[0]?.([]);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    await act(async () => {
      lists[1]?.([]);
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });

    expect(api.createSession).toHaveBeenCalledTimes(1);
    expect(storage.store.get('agenthub.simpleSession:cam')).toBe('cam-1');
    expect(navigation.navigate).toHaveBeenCalledWith('SimpleChat', {
      kind: 'agent',
      agentId: 'cam',
      sessionId: 'cam-1',
    });
    api.getSessions.mockImplementation(original);
    api.createSession.mockReset();
  });
});
