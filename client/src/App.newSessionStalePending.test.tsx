/**
 * App: "+ New Session" must never surface a stale foreign session from another
 * project.
 *
 * Regression test for the support bug "Hitting a new session sometimes brings
 * up an existing session in the wrong project".
 *
 * Mechanism: a cross-project focus that targets the ALREADY-active agent parks
 * a session id in `pendingSessionIdRef` but does not change `activeAgentId`, so
 * the sessions-load effect never re-runs to consume (null) it. When the user
 * then clicks "+ New Session" on a DIFFERENT project's agent, `handleNewSession`
 * used to leave that stale id in place. The agent-change load effect read it as
 * the deep-link target, found it absent from the new agent's owned list, and
 * fetched it cross-project via `api.getSession` — surfacing the other project's
 * populated session instead of the freshly created empty one.
 *
 * Fix: `handleNewSession` sets `pendingSessionIdRef.current = session.id`, so
 * the load effect deep-links to the new session (an owned row) and can never
 * fall through to the stale foreign id.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, cleanup } from '@testing-library/react';

const ctl = vi.hoisted(() => ({
  resolveProjects: null as any,
  resolveSessionsByAgent: {} as Record<string, any>,
  onNewSession: null as any,
  onFocusSession: null as any,
  getSession: null as any,
  NEW_SESSION: {
    id: 's-new-b',
    agent_id: 'agent-b',
    engine: 'claude-code',
    model: 'claude-opus-4-8',
  } as any,
  // The stale foreign session parked in pendingSessionIdRef — owned by agent-c
  // in the OTHER project, absent from agent-b's session list.
  FOREIGN: { id: 's-foreign-z', agent_id: 'agent-c', engine: 'claude-code' } as any,
}));

(vi as any).mock('./utils/orgs.js', () => ({
  migrateFromLegacy: () => Promise.resolve(),
  fetchOrgs: () => Promise.resolve(),
  getActiveOrg: () => null,
  getOrgs: () => ({ orgs: [] }),
  getActiveOrgApiId: () => 'default',
  switchOrg: () => Promise.resolve(),
  reloadForOrgSwitch: () => {},
}));

(vi as any).mock('./utils/connection.js', () => ({
  getApiBase: () => 'http://localhost:3051',
  getAuthHeaders: () => ({}),
  getServerBase: () => 'http://localhost:3051',
}));

(vi as any).mock('./components/Sidebar.jsx', () => ({
  default: function MockSidebar(p: any) {
    (globalThis as any).__ahActiveSessionIdFromSidebar = p.activeSessionId;
    ctl.onNewSession = p.onNewSession;
    ctl.onFocusSession = p.onFocusSession;
    return <div data-testid="sidebar" data-active-session-id={p.activeSessionId || ''} />;
  },
}));

(vi as any).mock('./components/SessionSummarySidebar.jsx', () => ({
  default: function MockSessionSummary() {
    return <div data-testid="session-summary-mock" />;
  },
}));

(vi as any).mock('./hooks/useWebSocket.js', () => ({
  useWebSocket: () => ({
    send: vi.fn(),
    connected: true,
    reconnecting: false,
    wsRef: { current: null },
  }),
}));
(vi as any).mock('./hooks/useDesktopNotifications.js', () => ({
  useDesktopNotifications: () => ({ notify: vi.fn() }),
}));
(vi as any).mock('./hooks/useKeyboardShortcuts.js', () => ({
  useKeyboardShortcuts: () => {},
}));
(vi as any).mock('./hooks/useVersionCheck.js', () => ({
  useVersionCheck: () => ({
    updateAvailable: false,
    serverVersion: null,
    clientVersion: '0',
    downloadUrl: '',
    dismiss: vi.fn(),
  }),
}));

(vi as any).mock('./utils/api.js', async (importOriginal: any) => {
  const mod = await importOriginal();
  const empty = { engineDefaultModels: { 'claude-code': 'claude-opus-4-8' } };
  ctl.getSession = vi.fn().mockResolvedValue(ctl.FOREIGN);
  return {
    ...mod,
    api: {
      ...mod.api,
      getModelConfig: vi.fn().mockResolvedValue(empty),
      getProjects: vi.fn(
        () =>
          new Promise((resolve: any) => {
            ctl.resolveProjects = resolve;
          }),
      ),
      getSessions: vi.fn(
        (agentId: any) =>
          new Promise((resolve: any) => {
            ctl.resolveSessionsByAgent[agentId] = resolve;
          }),
      ),
      createSession: vi.fn().mockResolvedValue(ctl.NEW_SESSION),
      // Cross-project deep-link fetch. If the bug is present this is called with
      // the foreign id and its result becomes the active session.
      getSession: (...args: any[]) => ctl.getSession(...args),
      getArchivedSessions: vi.fn().mockResolvedValue([]),
      getSkills: vi.fn().mockResolvedValue([]),
      getDesigns: vi.fn().mockResolvedValue([]),
      getCronSessions: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockResolvedValue([]),
      getSessionHandoffs: vi.fn().mockResolvedValue([]),
      getSessionProgress: vi.fn().mockResolvedValue({ steps: [] }),
      ensureSessionWorkspace: vi.fn().mockResolvedValue({ ok: true, skipped: true } as any),
    },
  };
});

const PROJECT_FIXTURE = [
  {
    id: 'proj-1',
    name: 'Project One',
    color: '#3b82f6',
    cwd: '/tmp/w1',
    ahw: '/tmp/w1',
    agents: [{ id: 'agent-c', name: 'C', color: '#3b82f6', engine: 'claude-code' }],
  },
  {
    id: 'proj-2',
    name: 'Project Two',
    color: '#22c55e',
    cwd: '/tmp/w2',
    ahw: '/tmp/w2',
    agents: [{ id: 'agent-b', name: 'B', color: '#22c55e', engine: 'claude-code' }],
  },
];

import App from './App';

function mockFetch() {
  (globalThis as any).fetch = vi.fn((url: any) => {
    const u = String(url);
    if (u.includes('/setup/status')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ firstRun: false }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

describe('App — "+ New Session" with a stale cross-project pending session id', () => {
  const origElectron = globalThis.window.electronAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    ctl.resolveProjects = null;
    ctl.resolveSessionsByAgent = {};
    ctl.onNewSession = null;
    ctl.onFocusSession = null;
    localStorage.clear();
    globalThis.window.electronAPI = undefined;
    mockFetch();
    delete (globalThis as any).__ahActiveSessionIdFromSidebar;
  });

  afterEach(() => {
    cleanup();
    globalThis.window.electronAPI = origElectron;
  });

  it('opens the new session, not the foreign session left in pendingSessionIdRef', async () => {
    localStorage.setItem('activeAgentId', 'agent-c');

    render(<App />);

    await waitFor(() => expect(typeof ctl.resolveProjects).toBe('function'), { timeout: 3000 });
    await act(async () => {
      ctl.resolveProjects(PROJECT_FIXTURE);
    });

    // Initial load for the active agent-c consumes any pending id (null here).
    await waitFor(() => expect(typeof ctl.resolveSessionsByAgent['agent-c']).toBe('function'), {
      timeout: 3000,
    });
    await act(async () => {
      ctl.resolveSessionsByAgent['agent-c']([
        { id: 's-c1', agent_id: 'agent-c', engine: 'claude-code' },
      ]);
    });
    await waitFor(() => expect(typeof ctl.onFocusSession).toBe('function'));

    // Focus a foreign session while agent-c is ALREADY active. This parks
    // 's-foreign-z' in pendingSessionIdRef; because activeAgentId does not
    // change, the sessions-load effect never re-runs to consume it.
    await act(async () => {
      ctl.onFocusSession('agent-c', 's-foreign-z');
    });
    await waitFor(() =>
      expect((globalThis as any).__ahActiveSessionIdFromSidebar).toBe('s-foreign-z'),
    );

    // Now click "+ New Session" under agent-b (the other project's agent).
    await act(async () => {
      await ctl.onNewSession('agent-b');
    });

    // The agent-change load effect fires for agent-b. Its owned list contains
    // the freshly created session but NOT the foreign one.
    await waitFor(() => expect(typeof ctl.resolveSessionsByAgent['agent-b']).toBe('function'), {
      timeout: 3000,
    });
    await act(async () => {
      ctl.resolveSessionsByAgent['agent-b']([ctl.NEW_SESSION]);
    });

    // The new session wins; the foreign cross-project session must NOT be
    // deep-link fetched and selected.
    await waitFor(() => expect((globalThis as any).__ahActiveSessionIdFromSidebar).toBe('s-new-b'));
    expect((globalThis as any).__ahActiveSessionIdFromSidebar).not.toBe('s-foreign-z');
    expect(ctl.getSession).not.toHaveBeenCalledWith('s-foreign-z');
  });
});
