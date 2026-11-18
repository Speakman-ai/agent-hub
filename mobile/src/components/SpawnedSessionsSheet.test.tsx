import type { ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NODE_ENV = 'development';
const React = (await import('react')).default;
const TestRenderer = (await import('react-test-renderer')).default;

function nativeHost(name: string) {
  return ({ children, ...props }: any) => React.createElement(name, props, children);
}

const getSpawnedSessions = vi.hoisted(() => vi.fn());
const deleteSession = vi.hoisted(() => vi.fn());
const restoreSession = vi.hoisted(() => vi.fn());
const openSpawnedSession = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => new Set<(data: any) => void>());

vi.mock('react-native', () => ({
  Modal: nativeHost('Modal'),
  Pressable: nativeHost('Pressable'),
  SafeAreaView: nativeHost('SafeAreaView'),
  ScrollView: nativeHost('ScrollView'),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: nativeHost('Text'),
  View: nativeHost('View'),
}));
vi.mock('lucide-react-native', () => ({
  Archive: nativeHost('Icon'),
  ArrowLeft: nativeHost('Icon'),
  RotateCcw: nativeHost('Icon'),
  X: nativeHost('Icon'),
}));
vi.mock('./SessionStateIcon', () => ({ default: nativeHost('SessionStateIcon') }));
vi.mock('../utils/api', () => ({
  api: { getSpawnedSessions, deleteSession, restoreSession },
}));
vi.mock('../context/AppContext', () => ({
  useApp: () => ({
    agents: [{ id: 'agent-2', name: 'Bea' }],
    activeTasks: {},
    finalizeStatusBySession: {},
    needsInputBySession: {},
    openSpawnedSession,
    subscribeSpawnedSessionEvents: (cb: (data: any) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  }),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
  },
}));

const { default: SpawnedSessionsSheet } = await import('./SpawnedSessionsSheet');
const { getOrchestrateLaunchSettings, resetOrchestrateLaunchStateForTests } =
  await import('../context/orchestrateLaunchSettings');

const parent = { id: 'parent-1', name: 'Project chat', agent_id: 'agent-1' };

function byId(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.findByProps({ testID });
}

async function renderSheet(activeSessionId = 'parent-1') {
  getSpawnedSessions.mockResolvedValue({
    parent,
    sessions: [
      {
        id: 'child-1',
        name: 'Fix login',
        agent_id: 'agent-2',
        state: 'waiting_for_user_input',
        updated_at: '2026-11-12 12:00:00',
      },
    ],
    archived: [],
  });
  let renderer!: ReactTestRenderer;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(
      <SpawnedSessionsSheet
        visible
        parentSessionId="parent-1"
        activeSessionId={activeSessionId}
        onClose={vi.fn()}
      />,
    );
  });
  await TestRenderer.act(async () => {
    await Promise.resolve();
  });
  return renderer;
}

describe('SpawnedSessionsSheet', () => {
  beforeEach(() => {
    getSpawnedSessions.mockReset();
    deleteSession.mockReset();
    restoreSession.mockReset();
    openSpawnedSession.mockReset();
    listeners.clear();
    resetOrchestrateLaunchStateForTests();
  });

  it('opens a spawned session and remembers the default build mode', async () => {
    const renderer = await renderSheet();
    const status = byId(renderer, 'spawned-session-status-child-1').props.children;
    expect(Array.isArray(status) ? status.join('') : status).toContain('Waiting for user input');
    await TestRenderer.act(async () => {
      byId(renderer, 'spawned-session-child-1').props.onPress();
    });
    expect(openSpawnedSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'child-1', spawned_from_session_id: 'parent-1' }),
    );

    await TestRenderer.act(async () => {
      byId(renderer, 'orchestrate-default-build').props.onPress();
    });
    await TestRenderer.act(async () => {
      byId(renderer, 'orchestrate-build-merge').props.onPress();
    });
    await TestRenderer.act(async () => {
      byId(renderer, 'orchestrate-auto-start').props.onPress();
    });
    expect(getOrchestrateLaunchSettings('parent-1')).toEqual({ mode: 'merge', autoStart: true });
    renderer.unmount();
  });

  it('archives a session and can restore it', async () => {
    deleteSession.mockResolvedValue({});
    restoreSession.mockResolvedValue({});
    const renderer = await renderSheet('child-1');
    await TestRenderer.act(async () => {
      await byId(renderer, 'spawned-session-delete-child-1').props.onPress();
    });
    expect(deleteSession).toHaveBeenCalledWith('child-1');
    expect(openSpawnedSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'parent-1', agent_id: 'agent-1' }),
    );
    await TestRenderer.act(async () => {
      byId(renderer, 'spawned-archived-toggle').props.onPress();
    });
    await TestRenderer.act(async () => {
      await byId(renderer, 'spawned-session-restore-child-1').props.onPress();
    });
    expect(restoreSession).toHaveBeenCalledWith('child-1');
    expect(byId(renderer, 'spawned-session-child-1')).toBeTruthy();
    renderer.unmount();
  });

  it('keeps a worker created while the first load was in flight', async () => {
    let resolve!: (value: unknown) => void;
    getSpawnedSessions.mockReturnValue(new Promise((r) => (resolve = r)));
    let renderer!: ReactTestRenderer;
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(
        <SpawnedSessionsSheet
          visible
          parentSessionId="parent-1"
          activeSessionId="parent-1"
          onClose={vi.fn()}
        />,
      );
    });
    await TestRenderer.act(async () => {
      for (const listener of listeners) {
        listener({
          type: 'session_forwarded',
          session: {
            id: 'child-new',
            name: 'New worker',
            agent_id: 'agent-2',
            spawned_from_session_id: 'parent-1',
          },
        });
      }
    });
    await TestRenderer.act(async () => {
      resolve({
        parent,
        sessions: [
          {
            id: 'child-1',
            name: 'Fix login',
            agent_id: 'agent-2',
            state: 'waiting_for_user_input',
            updated_at: '2026-11-12 12:00:00',
          },
        ],
        archived: [],
      });
    });
    expect(byId(renderer, 'spawned-session-child-new')).toBeTruthy();
    expect(byId(renderer, 'spawned-session-child-1')).toBeTruthy();
    renderer.unmount();
  });

  it("never shows the previous parent's workers while the next parent loads", async () => {
    const renderer = await renderSheet();
    expect(byId(renderer, 'spawned-session-child-1')).toBeTruthy();
    let resolveNext!: (value: unknown) => void;
    getSpawnedSessions.mockReturnValueOnce(new Promise((r) => (resolveNext = r)));
    await TestRenderer.act(async () => {
      renderer.update(
        <SpawnedSessionsSheet
          visible
          parentSessionId="parent-2"
          activeSessionId="parent-2"
          onClose={vi.fn()}
        />,
      );
    });
    expect(renderer.root.findAllByProps({ testID: 'spawned-session-child-1' })).toHaveLength(0);
    await TestRenderer.act(async () => {
      resolveNext({
        parent: { id: 'parent-2', name: 'Other chat', agent_id: 'agent-1' },
        sessions: [
          {
            id: 'child-2',
            name: 'Other worker',
            agent_id: 'agent-2',
            state: 'waiting_for_user_input',
            updated_at: '2026-11-12 12:00:00',
          },
        ],
        archived: [],
      });
    });
    expect(byId(renderer, 'spawned-session-child-2')).toBeTruthy();
    expect(renderer.root.findAllByProps({ testID: 'spawned-session-child-1' })).toHaveLength(0);
    renderer.unmount();
  });

  it('links a nested Orchestrate chat up to the chat that started it', async () => {
    getSpawnedSessions.mockResolvedValue({
      parent: {
        id: 'worker-1',
        name: 'Worker chat',
        agent_id: 'agent-1',
        up: { id: 'parent-1', name: 'Project chat', agent_id: 'agent-1' },
      },
      sessions: [],
      archived: [],
    });
    let renderer!: ReactTestRenderer;
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(
        <SpawnedSessionsSheet
          visible
          parentSessionId="worker-1"
          activeSessionId="worker-1"
          onClose={vi.fn()}
        />,
      );
    });
    await TestRenderer.act(async () => {
      byId(renderer, 'spawned-sessions-back').props.onPress();
    });
    expect(openSpawnedSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'parent-1', name: 'Project chat' }),
    );
    renderer.unmount();
  });

  it('does not invent a mode for a restored worker it opens', async () => {
    deleteSession.mockResolvedValue({});
    restoreSession.mockResolvedValue({});
    const renderer = await renderSheet();
    await TestRenderer.act(async () => {
      await byId(renderer, 'spawned-session-delete-child-1').props.onPress();
    });
    await TestRenderer.act(async () => {
      byId(renderer, 'spawned-archived-toggle').props.onPress();
    });
    await TestRenderer.act(async () => {
      await byId(renderer, 'spawned-session-restore-child-1').props.onPress();
    });
    await TestRenderer.act(async () => {
      byId(renderer, 'spawned-session-child-1').props.onPress();
    });
    const opened = openSpawnedSession.mock.calls.at(-1)![0];
    expect(opened).toMatchObject({ id: 'child-1', spawned_from_session_id: 'parent-1' });
    expect(opened).not.toHaveProperty('session_mode');
    renderer.unmount();
  });
});
