/**
 * App: chat empty state copy.
 *
 * Regression coverage for the "What even is this page" bug report — when a
 * user lands on the chat view with no messages yet, the empty state must
 * make it obvious (a) what page they're on ("Chat"), (b) which agent the
 * conversation is with, and (c) what they can do next. The previous copy
 * ("Start a conversation" + agent name) was too sparse and users reported
 * not knowing what the page was for.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, cleanup, screen } from '@testing-library/react';

const ctl = vi.hoisted(() => ({
  resolveProjects: null as any,
  /** @type {Record<string, (value: unknown) => void>} */
  resolveSessionsByAgent: {} as Record<string, any> as Record<string, any> as Record<string, any>,
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
    if (typeof globalThis !== 'undefined') {
      if (p.onSelectAgent) (globalThis as any).__ahTestSelectAgent = p.onSelectAgent;
      if (p.onSelectSession) (globalThis as any).__ahTestSelectSession = p.onSelectSession;
    }
    return <div data-testid="sidebar-mock" aria-label="mock sidebar" />;
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
      getArchivedSessions: vi.fn().mockResolvedValue([]),
      getSkills: vi.fn().mockResolvedValue([]),
      getDesigns: vi.fn().mockResolvedValue([]),
      getCronSessions: vi.fn().mockResolvedValue([]),
      // Empty messages list — drives the empty-state branch.
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
    name: 'Project',
    color: '#3b82f6',
    cwd: '/tmp/w',
    ahw: '/tmp/w',
    agents: [{ id: 'agent-1', name: 'Hub Frontend', color: '#3b82f6', engine: 'claude-code' }],
  },
];

const ONE_SESSION = [{ id: 's-1', name: 'S1', engine: 'claude-code' }];

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

describe('App — chat empty-state identifies the page and agent', () => {
  const origElectron = globalThis.window.electronAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    ctl.resolveProjects = null;
    ctl.resolveSessionsByAgent = {};
    localStorage.clear();
    globalThis.window.electronAPI = undefined;
    mockFetch();
    delete (globalThis as any).__ahTestSelectAgent;
    delete (globalThis as any).__ahTestSelectSession;
  });

  afterEach(() => {
    cleanup();
    globalThis.window.electronAPI = origElectron;
  });

  it('shows a "Chat" page tag, agent name, and orientation copy when the session has no messages', async () => {
    render(<App initialView="chat" />);

    await waitFor(() => expect(typeof ctl.resolveProjects).toBe('function'), { timeout: 3000 });
    await act(async () => {
      ctl.resolveProjects(PROJECT_FIXTURE);
    });
    await waitFor(() => expect(typeof ctl.resolveSessionsByAgent['agent-1']).toBe('function'), {
      timeout: 3000,
    });
    await act(async () => {
      ctl.resolveSessionsByAgent['agent-1'](ONE_SESSION);
    });

    const empty = await screen.findByTestId('chat-empty-state');
    expect(empty!).toBeInTheDocument();

    // Page identifier — small uppercase "Chat" tag tells the user what view they're on.
    expect(empty!).toHaveTextContent(/chat/i);
    // Headline names the agent so the user knows who they're talking to.
    expect(empty!).toHaveTextContent(/Talk to Hub Frontend/i);
    // Orientation sentence explains what to do next ("Type a message…").
    expect(empty!).toHaveTextContent(/type a message/i);
    // Keyboard-shortcut hint is preserved (regression guard).
    expect(empty!).toHaveTextContent(/Ctrl\+K to switch agents/);
  });

  it('lands on the Dashboard (home view) by default, not the chat view', async () => {
    // Regression guard for "make dashboard the home page": rendering App
    // with no explicit view must mount the org Dashboard, even though a
    // session auto-restores in the background. Previously the app defaulted
    // to the chat view.
    render(<App />);

    await waitFor(() => expect(typeof ctl.resolveProjects).toBe('function'), { timeout: 3000 });
    await act(async () => {
      ctl.resolveProjects(PROJECT_FIXTURE);
    });
    await waitFor(() => expect(typeof ctl.resolveSessionsByAgent['agent-1']).toBe('function'), {
      timeout: 3000,
    });
    await act(async () => {
      ctl.resolveSessionsByAgent['agent-1'](ONE_SESSION);
    });

    // The Dashboard heading is present…
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    // …and we did NOT default into the chat empty-state.
    expect(screen.queryByTestId('chat-empty-state')).not.toBeInTheDocument();
  });
});
