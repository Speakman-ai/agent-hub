/**
 * App: "+ New Session" started from a Consult session must NOT create another
 * Consult session — it starts at the project default mode.
 *
 * Regression test for the support bug "navigating from a session in Consult
 * mode to a new session keeps Consult activated even though the project default
 * is auto-merge; only happens with Consult".
 *
 * Mechanism: Consult was the only mode carried across navigation as a top-level
 * React boolean (`sessionConsultMode`). `handleNewSession` seeded the new row
 * with `consultMode: sessionConsultMode`, so the server genuinely created it as
 * `session_mode: 'consult'`. Because Consult is not shipping-compatible, the
 * server then skipped applying the project's default Finalize automation.
 *
 * Fix: new sessions never inherit Consult; `handleNewSession` calls
 * `createSession(agentId, undefined)` with no consult flag, letting the server
 * apply the project default. Consult stays a per-session opt-in via the picker.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, cleanup } from '@testing-library/react';

const ctl = vi.hoisted(() => ({
  resolveProjects: null as any,
  resolveSessionsByAgent: {} as Record<string, any>,
  onNewSession: null as any,
  onFocusSession: null as any,
  createSession: null as any,
  // The active session is Consult; the new one the server hands back is not.
  CONSULT: {
    id: 's-consult',
    agent_id: 'agent-a',
    engine: 'claude-code',
    model: 'claude-opus-4-8',
    session_mode: 'consult',
  } as any,
  NEW_SESSION: {
    id: 's-new-a',
    agent_id: 'agent-a',
    engine: 'claude-code',
    model: 'claude-opus-4-8',
    session_mode: 'chat',
  } as any,
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
  ctl.createSession = vi.fn().mockResolvedValue(ctl.NEW_SESSION);
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
      createSession: (...args: any[]) => ctl.createSession(...args),
      getSession: vi.fn().mockResolvedValue(ctl.CONSULT),
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
    agents: [{ id: 'agent-a', name: 'A', color: '#3b82f6', engine: 'claude-code' }],
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

describe('App — "+ New Session" from a Consult session', () => {
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
  });

  afterEach(() => {
    cleanup();
    globalThis.window.electronAPI = origElectron;
  });

  it('creates a non-Consult session (does not inherit the prior consult flag)', async () => {
    localStorage.setItem('activeAgentId', 'agent-a');

    render(<App />);

    await waitFor(() => expect(typeof ctl.resolveProjects).toBe('function'), { timeout: 3000 });
    await act(async () => {
      ctl.resolveProjects(PROJECT_FIXTURE);
    });

    // Load agent-a's sessions with the Consult session present, then focus it so
    // the session-switch effect flips sessionConsultMode true.
    await waitFor(() => expect(typeof ctl.resolveSessionsByAgent['agent-a']).toBe('function'), {
      timeout: 3000,
    });
    await act(async () => {
      ctl.resolveSessionsByAgent['agent-a']([ctl.CONSULT]);
    });
    await waitFor(() => expect(typeof ctl.onFocusSession).toBe('function'));
    await act(async () => {
      ctl.onFocusSession('agent-a', 's-consult');
    });

    // Now click "+ New Session" for the same agent while Consult is active.
    await waitFor(() => expect(typeof ctl.onNewSession).toBe('function'));
    await act(async () => {
      await ctl.onNewSession('agent-a');
    });

    expect(ctl.createSession).toHaveBeenCalled();
    const call = ctl.createSession.mock.calls.find((c: any[]) => c[0] === 'agent-a');
    expect(call).toBeTruthy();
    // The new session must not be forced into Consult. Before the fix the third
    // arg was `{ consultMode: true }`, which made the server create it as
    // session_mode: 'consult' and skip the project's default Finalize automation.
    const opts = call?.[2];
    expect(opts?.consultMode).not.toBe(true);
  });
});
