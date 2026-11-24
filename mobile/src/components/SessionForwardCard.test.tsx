import type { ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractedForward } from '@shared/utils/extractForwardBlocks';

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('../theme/colors', () => ({ colors: new Proxy({}, { get: () => '#000' }) }));

const storage = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn(async (key: string) => (store.has(key) ? store.get(key)! : null)),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    store,
  };
});
vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));

const dispatchSession = vi.hoisted(() => vi.fn());
const cancelOrchestrateAutoStart = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ api: { dispatchSession, cancelOrchestrateAutoStart } }));
vi.mock('../utils/auth', () => ({ getAuthRecord: () => ({ user: { id: 'user-1' } }) }));
vi.mock('../utils/config', () => ({ getServerBaseUrl: () => 'https://hub.test' }));

// The production React build has no `act`; load the development one.
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';
const React = await import('react');
const View = 'View' as unknown as React.ComponentType<{
  testID?: string;
  children?: React.ReactNode;
}>;
const TestRenderer = (await import('react-test-renderer')).default;
const {
  default: SessionForwardCard,
  forwardStore,
  forwardDock,
  SessionForwardSlot,
  SessionForwardDock,
  SessionForwardDockContext,
  createOpenForwardScanner,
} = await import('./SessionForwardCard');
const { orchestrateLaunch, setOrchestrateSessionActive } =
  await import('../context/orchestrateLaunchSettings');
process.env.NODE_ENV = originalNodeEnv;
const act = TestRenderer.act;

const forward: ExtractedForward = {
  forwardId: 'fwd-mobile',
  projectId: 'app',
  agentId: 'ada',
  name: 'Fix login',
  summary: 'Repair the redirect.',
  prompt: 'Fix the login redirect.',
  mode: 'manual',
};

function byId(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findByProps({ testID });
}

describe('SessionForwardCard (mobile)', () => {
  beforeEach(() => {
    dispatchSession.mockReset();
    cancelOrchestrateAutoStart.mockReset().mockResolvedValue({});
    storage.store.clear();
    forwardStore.clear();
    forwardDock.clear();
    orchestrateLaunch.resetForTests();
    vi.useRealTimers();
  });

  it('starts the session at the chosen ship level', async () => {
    dispatchSession.mockResolvedValue({
      sessionId: 'sess-9',
      agentId: 'ada',
      projectId: 'app',
      name: 'Fix login',
      skippedSkills: [],
      ref: '@[Fix login](session:sess-9)',
    });
    const onOpenSession = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SessionForwardCard
          forward={forward}
          agents={[{ id: 'ada', name: 'Ada' }]}
          onOpenSession={onOpenSession}
        />,
      );
    });
    expect(byId(renderer, 'session-forward-summary').props.children).toBe('Repair the redirect.');
    await act(async () => {
      byId(renderer, 'session-forward-mode').props.onPress();
    });
    await act(async () => {
      byId(renderer, 'session-forward-mode-merge').props.onPress();
    });
    await act(async () => {
      await byId(renderer, 'session-forward').props.onPress();
    });
    expect(dispatchSession).toHaveBeenCalledWith('app', {
      prompt: forward.prompt,
      agentId: 'ada',
      name: 'Fix login',
      mode: 'merge',
    });
    await act(async () => {
      byId(renderer, 'session-forward-open').props.onPress();
    });
    expect(onOpenSession).toHaveBeenCalledWith('ada', 'sess-9');
    renderer.unmount();
  });

  async function mount(props: Record<string, unknown>) {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SessionForwardCard forward={forward} onOpenSession={() => {}} {...props} />,
      );
    });
    return renderer;
  }

  function has(renderer: ReactTestRenderer, testID: string): boolean {
    return renderer.root.findAllByProps({ testID }).length > 0;
  }

  it('keeps identical requests in different messages separate and restores each on reload', async () => {
    dispatchSession.mockResolvedValue({
      sessionId: 'sess-1',
      agentId: 'ada',
      projectId: 'app',
      name: 'Fix login',
      skippedSkills: [],
      ref: '',
    });
    const first = await mount({ sessionId: 'chat-1', messageId: 'm-1' });
    await act(async () => {
      await byId(first, 'session-forward').props.onPress();
    });
    expect(has(first, 'session-forward-open')).toBe(true);
    first.unmount();

    const other = await mount({ sessionId: 'chat-1', messageId: 'm-2' });
    expect(has(other, 'session-forward')).toBe(true);
    expect(has(other, 'session-forward-open')).toBe(false);
    other.unmount();

    const reloaded = await mount({ sessionId: 'chat-1', messageId: 'm-1' });
    expect(has(reloaded, 'session-forward-open')).toBe(true);
    expect(has(reloaded, 'session-forward')).toBe(false);
    reloaded.unmount();
    expect(dispatchSession).toHaveBeenCalledTimes(1);
  });

  it('offers Consult only and dispatches it for a workflow project', async () => {
    dispatchSession.mockResolvedValue({
      sessionId: 'sess-wf',
      agentId: 'ops',
      projectId: 'ops',
      name: 'Fix login',
      skippedSkills: [],
      ref: '',
    });
    const renderer = await mount({
      forward: { ...forward, projectId: 'ops', agentId: 'ops', mode: 'push' },
      projects: [{ id: 'ops', mode: 'workflow' }],
      sessionId: 'hub-1',
      messageId: 'm-1',
    });
    await act(async () => {
      byId(renderer, 'session-forward-mode').props.onPress();
    });
    expect(has(renderer, 'session-forward-mode-consult')).toBe(true);
    expect(has(renderer, 'session-forward-mode-merge')).toBe(false);
    await act(async () => {
      byId(renderer, 'session-forward-mode-consult').props.onPress();
    });
    await act(async () => {
      await byId(renderer, 'session-forward').props.onPress();
    });
    expect(dispatchSession).toHaveBeenCalledWith(
      'ops',
      {
        prompt: forward.prompt,
        agentId: 'ops',
        name: 'Fix login',
        mode: 'consult',
        idempotencyKey: `session-forward:hub-1:m-1:${forward.forwardId}:0`,
      },
      { parentSessionId: 'hub-1' },
    );
    renderer.unmount();
  });

  it('does not dispatch while the saved record for a forwarded card is still loading', async () => {
    let release!: (value: string | null) => void;
    let pending: Promise<string | null> | null = null;
    storage.getItem.mockImplementation((key: string) => {
      if (String(key).startsWith('agenthub:orchestrate-launch:')) {
        return Promise.resolve(storage.store.get(key) ?? null);
      }
      pending ??= new Promise<string | null>((resolve) => {
        release = resolve;
      });
      return pending;
    });
    const renderer = await mount({ sessionId: 'chat-1', messageId: 'm-1' });
    const button = byId(renderer, 'session-forward');
    expect(button.props.disabled).toBe(true);
    await act(async () => {
      await button.props.onPress();
    });
    expect(dispatchSession).not.toHaveBeenCalled();

    await act(async () => {
      release(
        JSON.stringify({ sessionId: 'sess-old', agentId: 'ada', name: 'Fix login', mode: 'push' }),
      );
    });
    expect(has(renderer, 'session-forward-open')).toBe(true);
    expect(has(renderer, 'session-forward')).toBe(false);
    expect(dispatchSession).not.toHaveBeenCalled();
    renderer.unmount();
    storage.getItem.mockImplementation(async (key: string) =>
      storage.store.has(key) ? storage.store.get(key)! : null,
    );
  });

  it('resets its claim when the same component is reused for another card', async () => {
    dispatchSession
      .mockResolvedValueOnce({
        sessionId: 'sess-a',
        agentId: 'ada',
        projectId: 'app',
        name: 'A',
        skippedSkills: [],
        ref: '',
      })
      .mockResolvedValueOnce({
        sessionId: 'sess-b',
        agentId: 'ada',
        projectId: 'app',
        name: 'B',
        skippedSkills: [],
        ref: '',
      });
    const next = { ...forward, forwardId: 'fwd-next', prompt: 'Add logout.' };
    const renderer = await mount({ sessionId: 'chat-1', messageId: 'm-1' });
    await act(async () => {
      await byId(renderer, 'session-forward').props.onPress();
    });
    expect(has(renderer, 'session-forward-open')).toBe(true);

    await act(async () => {
      renderer.update(
        <SessionForwardCard
          forward={next}
          sessionId="chat-1"
          messageId="m-2"
          onOpenSession={() => {}}
        />,
      );
    });
    expect(byId(renderer, 'session-forward').props.disabled).toBe(false);
    await act(async () => {
      await byId(renderer, 'session-forward').props.onPress();
    });
    expect(has(renderer, 'session-forward-open')).toBe(true);
    expect(dispatchSession).toHaveBeenCalledTimes(2);
    expect(dispatchSession).toHaveBeenLastCalledWith(
      'app',
      expect.objectContaining({ prompt: 'Add logout.' }),
      { parentSessionId: 'chat-1' },
    );
    renderer.unmount();
  });

  it('does not show an in-flight dispatch result on the card that replaced it', async () => {
    let finish!: (value: unknown) => void;
    dispatchSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const next = { ...forward, forwardId: 'fwd-next', prompt: 'Add logout.' };
    const renderer = await mount({ sessionId: 'chat-1', messageId: 'm-1' });
    let pressed!: Promise<void>;
    await act(async () => {
      pressed = byId(renderer, 'session-forward').props.onPress();
    });
    await act(async () => {
      renderer.update(
        <SessionForwardCard
          forward={next}
          sessionId="chat-1"
          messageId="m-2"
          onOpenSession={() => {}}
        />,
      );
    });
    await act(async () => {
      finish({
        sessionId: 'sess-a',
        agentId: 'ada',
        projectId: 'app',
        name: 'A',
        skippedSkills: [],
        ref: '',
      });
      await pressed;
    });
    expect(has(renderer, 'session-forward-open')).toBe(false);
    expect(byId(renderer, 'session-forward').props.disabled).toBe(false);
    expect(storage.store.size).toBe(1);
    renderer.unmount();
  });

  it('starts one session when the card unmounts and remounts mid-dispatch', async () => {
    let finish!: (value: unknown) => void;
    dispatchSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = await mount({ sessionId: 'chat-1', messageId: 'm-1' });
    let pressed!: Promise<void>;
    await act(async () => {
      pressed = byId(first, 'session-forward').props.onPress();
    });
    first.unmount();

    const second = await mount({ sessionId: 'chat-1', messageId: 'm-1' });
    expect(byId(second, 'session-forward').props.disabled).toBe(true);
    await act(async () => {
      await byId(second, 'session-forward').props.onPress();
    });
    expect(dispatchSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish({
        sessionId: 'sess-1',
        agentId: 'ada',
        projectId: 'app',
        name: 'Fix login',
        skippedSkills: [],
        ref: '',
      });
      await pressed;
    });
    expect(has(second, 'session-forward-open')).toBe(true);
    expect(has(second, 'session-forward')).toBe(false);
    expect(dispatchSession).toHaveBeenCalledTimes(1);
    second.unmount();
  });

  it('dismisses without starting anything and stays dismissed on reload', async () => {
    const first = await mount({ sessionId: 'chat-1', messageId: 'm-1' });
    await act(async () => {
      byId(first, 'session-forward-dismiss').props.onPress();
    });
    expect(has(first, 'session-forward-dismissed')).toBe(true);
    expect(has(first, 'session-forward')).toBe(false);
    // Auto start must not start a dismissed card later either.
    expect(cancelOrchestrateAutoStart).toHaveBeenCalledWith('chat-1', {
      messageId: 'm-1',
      forwardId: 'fwd-mobile',
      occurrence: 0,
    });
    first.unmount();
    forwardStore.clear();

    const second = await mount({ sessionId: 'chat-1', messageId: 'm-1' });
    expect(has(second, 'session-forward-dismissed')).toBe(true);
    expect(dispatchSession).not.toHaveBeenCalled();
    second.unmount();
  });

  it('pins an open card to the dock until it is dismissed, then shows it in its message', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SessionForwardDockContext.Provider value>
          <View testID="message-1">
            <SessionForwardSlot forward={forward} sessionId="chat-1" messageId="m-1" />
          </View>
          <SessionForwardDock chatSessionId="chat-1" />
        </SessionForwardDockContext.Provider>,
      );
    });
    const inMessage = () =>
      byId(renderer, 'message-1').findAll((node) => node.props.testID === 'session-forward-card');
    expect(inMessage()).toHaveLength(0);
    expect(has(renderer, 'session-forward-dock')).toBe(true);

    await act(async () => {
      byId(renderer, 'session-forward-dismiss').props.onPress();
    });
    expect(has(renderer, 'session-forward-dock')).toBe(false);
    expect(inMessage()).toHaveLength(1);
    expect(has(renderer, 'session-forward-dismissed')).toBe(true);
    renderer.unmount();
  });

  it('keeps a streaming card in its message', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SessionForwardDockContext.Provider value>
          <SessionForwardSlot forward={forward} sessionId="chat-1" messageId="m-1" streaming />
        </SessionForwardDockContext.Provider>,
      );
    });
    expect(has(renderer, 'session-forward-card')).toBe(true);
    expect(forwardDock.snapshot()).toHaveLength(0);
    renderer.unmount();
  });

  it('pins an open card from a long chat whose row never mounted', async () => {
    // Reopening a long chat: the list starts at the end, so the row that
    // proposed the card (m-20 of 60) is never rendered. Only stamped rows
    // have their events loaded.
    const stamp = JSON.stringify({ awaitingUserInput: true, awaitingUserInputKinds: ['forward'] });
    const messages = Array.from({ length: 60 }, (_, i) => ({
      id: `m-${i}`,
      session_id: 'chat-1',
      role: i % 2 ? 'assistant' : 'user',
      content: '',
      metadata: i === 21 || i === 41 ? stamp : null,
    }));
    const dismissed = { ...forward, forwardId: 'fwd-dismissed' };
    const rows = (f: typeof forward) => [{ seq: 1, event: { type: 'session_forward', ...f } }];
    const loadEvents = vi.fn(async (id: string) => rows(id === 'm-21' ? forward : dismissed));
    // m-41's card was dismissed in an earlier visit.
    let dismissedKey = '';
    {
      const probe = await mount({ forward: dismissed, sessionId: 'chat-1', messageId: 'm-41' });
      await act(async () => {
        byId(probe, 'session-forward-dismiss').props.onPress();
      });
      dismissedKey = [...storage.store.keys()][0];
      probe.unmount();
      forwardStore.clear();
    }
    expect(dismissedKey).toContain('fwd-dismissed');

    expect(await createOpenForwardScanner(loadEvents).scan(messages, {})).toEqual([]);
    expect(loadEvents.mock.calls.map(([id]) => id)).toEqual(['m-21', 'm-41']);

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<SessionForwardDock chatSessionId="chat-1" />);
    });
    const cards = renderer.root.findAll((node) => node.props.testID === 'session-forward-card');
    expect(cards).toHaveLength(1);
    expect(forwardDock.snapshot().map((entry) => entry.messageId)).toEqual(['m-21']);
    renderer.unmount();
  });

  describe('open forward scanner', () => {
    const stamped = (id: string) => ({
      id,
      session_id: 'chat-1',
      role: 'assistant',
      content: '',
      metadata: JSON.stringify({ awaitingUserInput: true, awaitingUserInputKinds: ['forward'] }),
    });
    const rows = [{ seq: 1, event: { type: 'session_forward', ...forward } }];

    it('retries a message whose events failed to load, then pins its card', async () => {
      const loadEvents = vi
        .fn<(id: string) => Promise<unknown[] | null>>()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(rows);
      const scanner = createOpenForwardScanner(loadEvents);
      const messages = [stamped('m-1')];

      expect(await scanner.scan(messages, {})).toEqual(['m-1']);
      expect(forwardDock.snapshot()).toHaveLength(0);

      expect(await scanner.scan(messages, {})).toEqual([]);
      expect(forwardDock.snapshot().map((entry) => entry.messageId)).toEqual(['m-1']);

      // Checked now: later scans do not load it again.
      await scanner.scan(messages, {});
      expect(loadEvents).toHaveBeenCalledTimes(2);
    });

    it('uses events that arrived after a failed load without fetching again', async () => {
      const loadEvents = vi.fn(async () => null);
      const scanner = createOpenForwardScanner(loadEvents);
      expect(await scanner.scan([stamped('m-1')], {})).toEqual(['m-1']);
      expect(await scanner.scan([stamped('m-1')], { 'm-1': rows })).toEqual([]);
      expect(loadEvents).toHaveBeenCalledTimes(1);
      expect(forwardDock.snapshot()).toHaveLength(1);
    });

    it('reports an in-flight failure to a scan that started while it was loading', async () => {
      let finish!: (value: unknown[] | null) => void;
      const loadEvents = vi.fn(
        () =>
          new Promise<unknown[] | null>((resolve) => {
            finish = resolve;
          }),
      );
      const scanner = createOpenForwardScanner(loadEvents);
      const first = scanner.scan([stamped('m-1')], {});
      const second = scanner.scan([stamped('m-1')], {});
      finish(null);
      expect(await first).toEqual(['m-1']);
      expect(await second).toEqual(['m-1']);
      expect(loadEvents).toHaveBeenCalledTimes(1);
    });

    it('skips unstamped messages without loading them', async () => {
      const loadEvents = vi.fn(async () => rows);
      const scanner = createOpenForwardScanner(loadEvents);
      const plain = { ...stamped('m-2'), metadata: null };
      expect(await scanner.scan([plain], {})).toEqual([]);
      expect(loadEvents).not.toHaveBeenCalled();
    });
  });

  describe('server Auto start', () => {
    const event = (data: Record<string, unknown>) =>
      act(() => {
        orchestrateLaunch.handleEvent(data);
      });
    const cardKey = 'session-forward:chat-1:m-1:fwd-mobile:0';

    it("shows the server's time left, then the session the server started", async () => {
      setOrchestrateSessionActive('chat-1', true);
      await event({
        type: 'orchestrate_launch_updated',
        sessionId: 'chat-1',
        settings: { mode: 'push', autoStart: true, revision: 1 },
      });
      await event({
        type: 'orchestrate_auto_start_scheduled',
        sessionId: 'chat-1',
        dispatchKey: cardKey,
        remainingMs: 10_000,
      });
      const renderer = await mount({ sessionId: 'chat-1', messageId: 'm-1' });
      expect(byId(renderer, 'session-forward-countdown').props.children).toMatch(
        /Starting in (10|9)s as Build and Push/,
      );
      await event({
        type: 'session_forward_started',
        sessionId: 'chat-1',
        dispatchKey: cardKey,
        started: { sessionId: 'srv-1', agentId: 'ada', name: 'Fix login', mode: 'push' },
      });
      expect(has(renderer, 'session-forward-countdown')).toBe(false);
      expect(has(renderer, 'session-forward-open')).toBe(true);
      expect(dispatchSession).not.toHaveBeenCalled();
      renderer.unmount();
    });

    it('cancels on the server and shows an error when the server did not take it', async () => {
      setOrchestrateSessionActive('chat-1', true);
      await event({
        type: 'orchestrate_auto_start_scheduled',
        sessionId: 'chat-1',
        dispatchKey: cardKey,
        remainingMs: 20_000,
      });
      const renderer = await mount({ sessionId: 'chat-1', messageId: 'm-1' });
      cancelOrchestrateAutoStart.mockRejectedValueOnce(new Error('offline'));
      await act(async () => {
        byId(renderer, 'session-forward-cancel-auto').props.onPress();
      });
      expect(has(renderer, 'session-forward-cancel-error')).toBe(true);
      expect(has(renderer, 'session-forward-countdown')).toBe(true);

      await act(async () => {
        byId(renderer, 'session-forward-cancel-auto').props.onPress();
      });
      expect(has(renderer, 'session-forward-countdown')).toBe(false);
      expect(cancelOrchestrateAutoStart).toHaveBeenLastCalledWith('chat-1', {
        messageId: 'm-1',
        forwardId: 'fwd-mobile',
        occurrence: 0,
      });
      renderer.unmount();
    });
  });

  it("starts a manual press at the Orchestrate chat's Default build", async () => {
    dispatchSession.mockResolvedValue({
      sessionId: 'sess-1',
      agentId: 'ada',
      projectId: 'app',
      name: 'Fix login',
      skippedSkills: [],
      ref: '',
    });
    act(() => {
      orchestrateLaunch.handleEvent({
        type: 'orchestrate_launch_updated',
        sessionId: 'chat-1',
        settings: { mode: 'push', autoStart: false, revision: 1 },
      });
    });
    setOrchestrateSessionActive('chat-1', true);
    const renderer = await mount({ sessionId: 'chat-1', messageId: 'm-1' });
    await act(async () => {
      await byId(renderer, 'session-forward').props.onPress();
    });
    expect(dispatchSession).toHaveBeenCalledWith('app', expect.objectContaining({ mode: 'push' }), {
      parentSessionId: 'chat-1',
    });
    renderer.unmount();
  });

  it('remembers the mode the session started with when another device started it first', async () => {
    dispatchSession.mockResolvedValue({
      sessionId: 'sess-1',
      agentId: 'ada',
      projectId: 'app',
      name: 'Fix login',
      mode: 'manual',
      skippedSkills: [],
      ref: '',
    });
    const renderer = await mount({ sessionId: 'chat-1', messageId: 'm-1' });
    await act(async () => {
      byId(renderer, 'session-forward-mode').props.onPress();
    });
    await act(async () => {
      byId(renderer, 'session-forward-mode-push').props.onPress();
    });
    await act(async () => {
      await byId(renderer, 'session-forward').props.onPress();
    });
    expect(dispatchSession).toHaveBeenCalledWith('app', expect.objectContaining({ mode: 'push' }), {
      parentSessionId: 'chat-1',
    });
    const saved = [...storage.store.values()].find((value) => value.includes('sess-1'));
    expect(JSON.parse(saved!)).toMatchObject({ sessionId: 'sess-1', mode: 'manual' });
    renderer.unmount();
  });
});
