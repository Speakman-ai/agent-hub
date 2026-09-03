/**
 * Regression (review of the Agent browser pane): the first `browser` action in
 * a session must visibly open the Agent browser pane even when a competing
 * right-slot pane (Terminal / Changes / Artifacts) is already open. Those panes
 * have priority in resolveSessionRightPaneFlags, so auto-open has to clear
 * their requests the same way the manual toggle does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent, cleanup } from '@testing-library/react';

const ctl = vi.hoisted(() => ({
  resolveProjects: null as any,
  /** @type {Record<string, (value: unknown) => void>} */
  resolveSessionsByAgent: {} as Record<string, any>,
  /** @type {((data: unknown) => void) | null} */
  onMessage: null as any,
  /** @type {unknown[]} */
  sends: [] as any[],
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
  default: function MockSidebar() {
    return <div data-testid="sidebar-mock" />;
  },
}));

(vi as any).mock('./components/SessionSummarySidebar.jsx', () => ({
  default: function MockSessionSummary() {
    return <div data-testid="session-summary-mock" />;
  },
}));

(vi as any).mock('./components/MessageInput.jsx', () => ({
  default: function MockMessageInput() {
    return <div data-testid="message-input-mock" />;
  },
}));

(vi as any).mock('./components/SessionBrowserPane', () => ({
  default: function MockBrowserPane({ sessionId }: any) {
    return <div data-testid="session-browser-pane">browser:{sessionId}</div>;
  },
}));

(vi as any).mock('./components/SessionTerminalPane', () => ({
  default: function MockTerminalPane() {
    return <div data-testid="session-terminal-pane-mock" />;
  },
}));

(vi as any).mock('./components/TopBar.jsx', () => ({
  default: function MockTopBar() {
    return <div data-testid="topbar-mock" />;
  },
}));

(vi as any).mock('./hooks/useWebSocket.js', () => ({
  useWebSocket: (onMessage: any) => {
    ctl.onMessage = onMessage;
    return {
      send: vi.fn((data: any) => {
        ctl.sends.push(data);
        return true;
      }),
      connected: true,
      reconnecting: false,
      wsRef: { current: null },
    };
  },
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
      getRooms: vi.fn().mockResolvedValue([]),
      getDesigns: vi.fn().mockResolvedValue([]),
      getCronSessions: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockResolvedValue([]),
      getSessionHandoffs: vi.fn().mockResolvedValue([]),
      getSessionProgress: vi.fn().mockResolvedValue({ steps: [] }),
      ensureSessionWorkspace: vi.fn().mockResolvedValue({ ok: true, skipped: true } as any),
      uploadImage: vi.fn(),
      uploadFile: vi.fn(),
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
    agents: [
      { id: 'agent-1', name: 'A1', color: '#3b82f6', engine: 'claude-code' },
      {
        id: 'reviewer-1',
        name: 'Reviewer',
        color: '#a855f7',
        engine: 'claude-code',
        role: 'reviewer',
      },
    ],
  },
];

const ONE_SESSION = [{ id: 's-1', name: 'S1', agent_id: 'agent-1', engine: 'claude-code' }];

import App from './App';
import { api } from './utils/api';

function mockFetch() {
  (globalThis as any).fetch = vi.fn((url: any) => {
    const u = String(url);
    if (u.includes('/setup/status')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ firstRun: false }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

async function openSession() {
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
  await waitFor(() => expect(api.getMessages).toHaveBeenCalled());
  await waitFor(() => expect(typeof ctl.onMessage).toBe('function'));
}

function browserStarted(seq = 1) {
  return {
    type: 'session-event',
    sessionId: 's-1',
    messageId: 'm-1',
    seq,
    event: {
      type: 'browser_tool_activity',
      phase: 'started',
      actionId: `a-${seq}`,
      op: 'navigate',
      label: 'Opening example.com',
      startedAtMs: Date.now(),
    },
  };
}

describe('App — Agent browser pane auto-open', () => {
  const origElectron = globalThis.window.electronAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    ctl.resolveProjects = null;
    ctl.resolveSessionsByAgent = {};
    ctl.onMessage = null;
    ctl.sends = [];
    localStorage.clear();
    globalThis.window.electronAPI = undefined;
    mockFetch();
  });

  afterEach(() => {
    cleanup();
    globalThis.window.electronAPI = origElectron;
  });

  it('opens the pane on the first browser action even when the Terminal pane holds the slot', async () => {
    await openSession();
    expect(screen.queryByTestId('session-browser-pane')).toBeNull();

    // Human opens the Terminal pane (Actions menu → Terminal).
    fireEvent.click(await screen.findByTestId('session-actions-trigger'));
    fireEvent.click(await screen.findByTestId('toggle-terminal-pane'));
    await screen.findByTestId('session-terminal-pane-mock');

    await act(async () => {
      (ctl.onMessage as any)(browserStarted(1));
    });

    // The first browser action takes the right-hand slot from the terminal.
    await screen.findByTestId('session-browser-pane');
    expect(screen.queryByTestId('session-terminal-pane-mock')).toBeNull();
  });

  it('does not reopen a pane the human closed', async () => {
    await openSession();
    await act(async () => {
      (ctl.onMessage as any)(browserStarted(1));
    });
    await screen.findByTestId('session-browser-pane');

    // Close via the reopen-pill state: simulate the human closing the pane.
    fireEvent.click(await screen.findByTestId('session-actions-trigger'));
    fireEvent.click(await screen.findByTestId('toggle-browser-pane'));
    await waitFor(() => expect(screen.queryByTestId('session-browser-pane')).toBeNull());
    await screen.findByTestId('reopen-browser-pane');

    await act(async () => {
      (ctl.onMessage as any)(browserStarted(2));
    });
    expect(screen.queryByTestId('session-browser-pane')).toBeNull();
    expect(screen.getByTestId('reopen-browser-pane')).toBeInTheDocument();
  });
});
