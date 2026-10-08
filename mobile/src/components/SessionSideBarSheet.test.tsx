import type { ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;

function nativeHost(name: string) {
  return ({ children, ...props }: any) => React.createElement(name, props, children);
}

const testState = vi.hoisted(() => ({
  getSessionSidebar: vi.fn(),
  getMessages: vi.fn(),
  openSessionSidebar: vi.fn(),
  closeSessionSidebar: vi.fn(),
  wsSend: vi.fn(),
  listeners: new Set<(data: any) => void>(),
  connected: true,
}));

vi.mock('react-native', () => ({
  ActivityIndicator: nativeHost('ActivityIndicator'),
  KeyboardAvoidingView: nativeHost('KeyboardAvoidingView'),
  Modal: nativeHost('Modal'),
  Platform: { OS: 'ios' },
  SafeAreaView: nativeHost('SafeAreaView'),
  ScrollView: nativeHost('ScrollView'),
  StyleSheet: { create: (styles: any) => styles },
  Text: nativeHost('Text'),
  TextInput: nativeHost('TextInput'),
  TouchableOpacity: nativeHost('TouchableOpacity'),
  View: nativeHost('View'),
}));
vi.mock('react-native-markdown-display', () => ({ default: nativeHost('Markdown') }));
vi.mock('lucide-react-native', () => ({
  MessageCircleQuestion: nativeHost('Icon'),
  RotateCcw: nativeHost('Icon'),
  Send: nativeHost('Icon'),
  Square: nativeHost('Icon'),
  Trash2: nativeHost('Icon'),
  X: nativeHost('Icon'),
}));
vi.mock('../utils/api', () => ({
  api: {
    getSessionSidebar: testState.getSessionSidebar,
    getMessages: testState.getMessages,
    openSessionSidebar: testState.openSessionSidebar,
    closeSessionSidebar: testState.closeSessionSidebar,
  },
}));
vi.mock('../context/AppContext', () => ({
  useApp: () => ({
    wsSend: testState.wsSend,
    connected: testState.connected,
    subscribeSideBarEvents: (cb: (data: any) => void) => {
      testState.listeners.add(cb);
      return () => testState.listeners.delete(cb);
    },
  }),
}));

const { default: SessionSideBarSheet } = await import('./SessionSideBarSheet');
const { sidebarStore } = await import('@shared/utils/sessionSidebarStore');

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function renderSheet() {
  let renderer!: ReactTestRenderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(
      <SessionSideBarSheet
        visible
        onClose={vi.fn()}
        parentSessionId="main-1"
        agentId="agent-1"
        agentName="Dev"
      />,
    );
    await flush();
  });
  return renderer;
}

const hostsWithTestId = (r: ReactTestRenderer, id: string) =>
  r.root.findAll((n) => typeof n.type === 'string' && n.props.testID === id);
const byTestId = (r: ReactTestRenderer, id: string) => r.root.findByProps({ testID: id });
const allText = (r: ReactTestRenderer) =>
  r.root
    .findAll((n) => typeof n.type === 'string')
    .flatMap((n) => n.children.filter((c) => typeof c === 'string'))
    .join(' ');

async function type(r: ReactTestRenderer, text: string) {
  await TestRenderer.act(async () => {
    byTestId(r, 'mobile-sidebar-input').props.onChangeText(text);
  });
}
async function pressSend(r: ReactTestRenderer) {
  await TestRenderer.act(async () => {
    byTestId(r, 'mobile-sidebar-send').props.onPress();
    await flush();
  });
}
async function emit(data: any) {
  await TestRenderer.act(async () => {
    testState.listeners.forEach((cb) => cb(data));
  });
}

describe('mobile SessionSideBarSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sidebarStore.clear();
    testState.wsSend.mockReset();
    testState.listeners.clear();
    testState.connected = true;
    testState.getMessages.mockResolvedValue([]);
  });

  it('opens the fork with the first question when no SideBar exists', async () => {
    testState.getSessionSidebar.mockResolvedValue({ session: null, running: false });
    testState.openSessionSidebar.mockResolvedValue({
      session: { id: 'sb-1' },
      forked: true,
      closedSessionIds: [],
    });
    const r = await renderSheet();
    await type(r, 'what is X?');
    await pressSend(r);
    expect(testState.openSessionSidebar).toHaveBeenCalledWith('main-1', 'what is X?');
    expect(testState.wsSend).not.toHaveBeenCalled();
  });

  it('sends follow-ups over the WebSocket and streams the answer', async () => {
    testState.getSessionSidebar.mockResolvedValue({ session: { id: 'sb-2' }, running: false });
    const r = await renderSheet();
    await type(r, 'and Y?');
    await pressSend(r);
    expect(testState.wsSend).toHaveBeenCalledWith({
      type: 'chat',
      agentId: 'agent-1',
      sessionId: 'sb-2',
      content: 'and Y?',
    });
    await emit({ type: 'stream', sessionId: 'sb-2', sidebarParentId: 'main-1', content: 'Y…' });
    expect(allText(r)).toContain('Y…');
    await emit({
      type: 'done',
      sessionId: 'sb-2',
      sidebarParentId: 'main-1',
      message: { id: 'a1', role: 'assistant', content: 'Y is done' },
    });
    expect(allText(r)).toContain('Y is done');
  });

  it('blocks sending until the lookup resolves', async () => {
    let resolveLookup: (v: any) => void = () => {};
    testState.getSessionSidebar.mockReturnValue(
      new Promise((res) => {
        resolveLookup = res;
      }),
    );
    const r = await renderSheet();
    expect(byTestId(r, 'mobile-sidebar-input').props.editable).toBe(false);
    await type(r, 'too early');
    await pressSend(r);
    expect(testState.openSessionSidebar).not.toHaveBeenCalled();
    expect(testState.wsSend).not.toHaveBeenCalled();

    await TestRenderer.act(async () => {
      resolveLookup({ session: { id: 'sb-live' }, running: false });
      await flush();
    });
    await pressSend(r);
    expect(testState.wsSend).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sb-live', content: 'too early' }),
    );
    expect(testState.openSessionSidebar).not.toHaveBeenCalled();
  });

  it('stays blocked after a failed lookup until Retry succeeds', async () => {
    testState.getSessionSidebar
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ session: { id: 'sb-r' }, running: false });
    const r = await renderSheet();
    expect(byTestId(r, 'mobile-sidebar-load-error')).toBeTruthy();
    await type(r, 'q');
    await pressSend(r);
    expect(testState.openSessionSidebar).not.toHaveBeenCalled();

    await TestRenderer.act(async () => {
      byTestId(r, 'mobile-sidebar-retry').props.onPress();
      await flush();
    });
    await pressSend(r);
    expect(testState.wsSend).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sb-r' }));
    expect(testState.openSessionSidebar).not.toHaveBeenCalled();
  });

  it('a done during a slow history load is not undone by the running snapshot', async () => {
    testState.getSessionSidebar.mockResolvedValue({ session: { id: 'sb-race' }, running: true });
    let resolveHistory: (v: any) => void = () => {};
    testState.getMessages.mockReturnValue(
      new Promise((res) => {
        resolveHistory = res;
      }),
    );
    const r = await renderSheet();
    expect(testState.getMessages).toHaveBeenCalledWith('sb-race');
    await emit({
      type: 'done',
      sessionId: 'sb-race',
      sidebarParentId: 'main-1',
      message: { id: 'a2', role: 'assistant', content: 'final answer' },
    });
    await TestRenderer.act(async () => {
      resolveHistory([{ id: 'u1', role: 'user', content: 'earlier question' }]);
      await flush();
    });
    expect(allText(r)).toContain('earlier question');
    expect(allText(r)).toContain('final answer');
    expect(r.root.findAllByProps({ testID: 'mobile-sidebar-stop' })).toHaveLength(0);
    expect(byTestId(r, 'mobile-sidebar-new').props.disabled).toBe(false);
    await type(r, 'follow-up');
    await pressSend(r);
    expect(testState.wsSend).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sb-race', content: 'follow-up' }),
    );
  });

  it('a rejected discard keeps the SideBar and its conversation', async () => {
    testState.getSessionSidebar.mockResolvedValue({ session: { id: 'sb-keep' }, running: false });
    testState.getMessages.mockResolvedValue([{ id: 'm1', role: 'assistant', content: 'keep me' }]);
    testState.closeSessionSidebar
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, closedSessionIds: ['sb-keep'] });
    const r = await renderSheet();
    expect(allText(r)).toContain('keep me');

    await TestRenderer.act(async () => {
      byTestId(r, 'mobile-sidebar-discard').props.onPress();
      await flush();
    });
    expect(allText(r)).toContain('keep me');
    expect(allText(r)).toContain('offline');
    await emit({
      type: 'stream',
      sessionId: 'sb-keep',
      sidebarParentId: 'main-1',
      content: 'live',
    });
    expect(allText(r)).toContain('live');
    await emit({ type: 'done', sessionId: 'sb-keep', sidebarParentId: 'main-1' });

    await TestRenderer.act(async () => {
      byTestId(r, 'mobile-sidebar-discard').props.onPress();
      await flush();
    });
    expect(allText(r)).not.toContain('keep me');
  });

  it('reconciles a turn that finished while the socket was down', async () => {
    testState.getSessionSidebar.mockResolvedValue({ session: { id: 'sb-off' }, running: false });
    testState.getMessages.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: 'u1', role: 'user', content: 'asked' },
      { id: 'a1', role: 'assistant', content: 'answered while offline' },
    ]);
    const r = await renderSheet();
    await type(r, 'asked');
    await pressSend(r);
    await emit({ type: 'thinking', sessionId: 'sb-off', sidebarParentId: 'main-1' });
    expect(hostsWithTestId(r, 'mobile-sidebar-stop')).toHaveLength(1);

    // A fresh element per update: React bails out of an identical one.
    const sheet = () => (
      <SessionSideBarSheet
        visible
        onClose={vi.fn()}
        parentSessionId="main-1"
        agentId="agent-1"
        agentName="Dev"
      />
    );
    for (const connected of [false, true]) {
      testState.connected = connected;
      await TestRenderer.act(async () => {
        r.update(sheet());
        await flush();
      });
    }
    expect(testState.getSessionSidebar).toHaveBeenCalledTimes(2);
    expect(allText(r)).toContain('answered while offline');
    // The question's WS echo never arrived; it must show once.
    expect(allText(r).split('asked').length - 1).toBe(1);
    expect(hostsWithTestId(r, 'mobile-sidebar-stop')).toHaveLength(0);
    expect(byTestId(r, 'mobile-sidebar-new').props.disabled).toBe(false);
  });

  it('a Retry that cannot send keeps the undelivered question', async () => {
    testState.getSessionSidebar.mockResolvedValue({ session: { id: 'sb-r2' }, running: false });
    testState.wsSend.mockReturnValue(false);
    const r = await renderSheet();
    await type(r, 'only copy');
    await pressSend(r);
    expect(hostsWithTestId(r, 'mobile-sidebar-undelivered')).toHaveLength(1);

    await TestRenderer.act(async () => {
      byTestId(r, 'mobile-sidebar-retry-question').props.onPress();
      await flush();
    });
    expect(testState.wsSend).toHaveBeenCalledTimes(2);
    expect(allText(r).split('only copy').length - 1).toBe(1);
    expect(hostsWithTestId(r, 'mobile-sidebar-undelivered')).toHaveLength(1);
  });

  it('a failed first question is still retryable after the sheet is closed and reopened', async () => {
    testState.getSessionSidebar.mockResolvedValue({ session: null, running: false });
    testState.openSessionSidebar.mockRejectedValueOnce(new Error('server down'));
    const r = await renderSheet();
    await type(r, 'keep me');
    await pressSend(r);
    expect(hostsWithTestId(r, 'mobile-sidebar-undelivered')).toHaveLength(1);
    await TestRenderer.act(async () => {
      r.unmount();
    });

    const reopened = await renderSheet();
    expect(allText(reopened)).toContain('keep me');
    expect(hostsWithTestId(reopened, 'mobile-sidebar-undelivered')).toHaveLength(1);
    testState.openSessionSidebar.mockResolvedValueOnce({
      session: { id: 'sb-ok', sidebar_seq: 1 },
      forked: true,
      closedSessionIds: [],
    });
    await TestRenderer.act(async () => {
      byTestId(reopened, 'mobile-sidebar-retry-question').props.onPress();
      await flush();
    });
    expect(testState.openSessionSidebar).toHaveBeenLastCalledWith('main-1', 'keep me');
  });
});
