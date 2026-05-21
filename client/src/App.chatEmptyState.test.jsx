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
  resolveProjects: null,
  /** @type {Record<string, (value: unknown) => void>} */
  resolveSessionsByAgent: {},
}));

vi.mock('./utils/orgs.js', () => ({
  migrateFromLegacy: () => Promise.resolve(),
  fetchOrgs: () => Promise.resolve(),
  getActiveOrg: () => null,
  getOrgs: () => ({ orgs: [] }),
  getActiveOrgApiId: () => 'default',
  switchOrg: () => Promise.resolve(),
  reloadForOrgSwitch: () => {},
}));

vi.mock('./utils/connection.js', () => ({
  getApiBase: () => 'http://localhost:3051',
  getAuthHeaders: () => ({}),
  getServerBase: () => 'http://localhost:3051',
}));

vi.mock('./components/Sidebar.jsx', () => ({
  default: function MockSidebar(p) {
    if (typeof globalThis !== 'undefined') {
      if (p.onSelectAgent) globalThis.__ahTestSelectAgent = p.onSelectAgent;
      if (p.onSelectSession) globalThis.__ahTestSelectSession = p.onSelectSession;
    }
    return <div data-testid="sidebar-mock" aria-label="mock sidebar" />;
  },
}));

vi.mock('./components/SessionSummarySidebar.jsx', () => ({
  default: function MockSessionSummary() {
    return <div data-testid="session-summary-mock" />;
  },
}));

vi.mock('./hooks/useWebSocket.js', () => ({
  useWebSocket: () => ({
    send: vi.fn(),
    connected: true,
    reconnecting: false,
    wsRef: { current: null },
  }),
}));
vi.mock('./hooks/useDesktopNotifications.js', () => ({
  useDesktopNotifications: () => ({ notify: vi.fn() }),
}));
vi.mock('./hooks/useKeyboardShortcuts.js', () => ({
  useKeyboardShortcuts: () => {},
}));
vi.mock('./hooks/useVersionCheck.js', () => ({
  useVersionCheck: () => ({
    updateAvailable: false,
    serverVersion: null,
    clientVersion: '0',
    downloadUrl: '',
    dismiss: vi.fn(),
  }),
}));

vi.mock('./utils/api.js', async (importOriginal) => {
  const mod = await importOriginal();
  const empty = { engineDefaultModels: { 'claude-code': 'claude-opus-4-7' } };
  return {
    ...mod,
    api: {
      ...mod.api,
      getModelConfig: vi.fn().mockResolvedValue(empty),
      getProjects: vi.fn(
        () =>
          new Promise((resolve) => {
            ctl.resolveProjects = resolve;
          }),
      ),
      getSessions: vi.fn(
        (agentId) =>
          new Promise((resolve) => {
            ctl.resolveSessionsByAgent[agentId] = resolve;
          }),
      ),
      getArchivedSessions: vi.fn().mockResolvedValue([]),
      getSkills: vi.fn().mockResolvedValue([]),
      getRooms: vi.fn().mockResolvedValue([]),
      getDesigns: vi.fn().mockResolvedValue([]),
      getCronSessions: vi.fn().mockResolvedValue([]),
      // Empty messages list — drives the empty-state branch.
      getMessages: vi.fn().mockResolvedValue([]),
      getSessionHandoffs: vi.fn().mockResolvedValue([]),
      getSessionProgress: vi.fn().mockResolvedValue({ steps: [] }),
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

import App from './App.jsx';

function mockFetch() {
  globalThis.fetch = vi.fn((url) => {
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
    delete globalThis.__ahTestSelectAgent;
    delete globalThis.__ahTestSelectSession;
  });

  afterEach(() => {
    cleanup();
    globalThis.window.electronAPI = origElectron;
  });

  it('shows a "Chat" page tag, agent name, and orientation copy when the session has no messages', async () => {
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

    const empty = await screen.findByTestId('chat-empty-state');
    expect(empty).toBeInTheDocument();

    // Page identifier — small uppercase "Chat" tag tells the user what view they're on.
    expect(empty).toHaveTextContent(/chat/i);
    // Headline names the agent so the user knows who they're talking to.
    expect(empty).toHaveTextContent(/Talk to Hub Frontend/i);
    // Orientation sentence explains what to do next ("Type a message…").
    expect(empty).toHaveTextContent(/type a message/i);
    // Keyboard-shortcut hint is preserved (regression guard).
    expect(empty).toHaveTextContent(/Ctrl\+K to switch agents/);
  });
});
