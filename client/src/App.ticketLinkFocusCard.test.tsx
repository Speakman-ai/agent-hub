/**
 * App integration: ticket links open the *specific* card, not just the board.
 *
 * Regression for "ticket links just go to the board". The board deep-link
 * plumbing (focusCardId → openDetail) already worked; the bug was that two
 * App-level onOpenCard callbacks dropped the card id:
 *   - the Session Summary sidebar callback (called with (projectId, cardId))
 *   - the Pull Requests page callback (called with (cardId))
 * Both switched to `kanban:<projectId>` without calling setKanbanFocusCardId,
 * so the card never opened. These tests drive the real App, invoke each
 * callback the way its child component does, and assert the mocked board
 * receives the focused card id.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, cleanup, screen, fireEvent } from '@testing-library/react';

const ctl = vi.hoisted(() => ({
  resolveProjects: null as any,
  resolveSessionsByAgent: {} as Record<string, any>,
  boardProps: null as any,
  sidebarProps: null as any,
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

(vi as any).mock('./components/Sidebar', () => ({
  default: function MockSidebar(p: any) {
    ctl.sidebarProps = p;
    return (
      <div data-testid="sidebar">
        <button data-testid="mock-select-session" onClick={() => p.onSelectSession('sess-1')}>
          select
        </button>
      </div>
    );
  },
}));

// TopBar renders in the chat view; stub it so the test doesn't depend on its
// (unrelated) internals.
(vi as any).mock('./components/TopBar', () => ({
  default: function MockTopBar() {
    return <div data-testid="topbar" />;
  },
}));

(vi as any).mock('./components/SessionSummarySidebar', () => ({
  default: function MockSessionSummarySidebar(p: any) {
    return (
      <button
        data-testid="mock-summary-open-card"
        onClick={() => p.onOpenCard && p.onOpenCard('proj-1', 'card-42')}
      >
        open ticket
      </button>
    );
  },
}));

(vi as any).mock('./components/PullRequestsPage', () => ({
  default: function MockPullRequestsPage(p: any) {
    return (
      <button
        data-testid="mock-pr-open-card"
        onClick={() => p.onOpenCard && p.onOpenCard('card-xyz')}
      >
        open linked card
      </button>
    );
  },
}));

(vi as any).mock('./components/KanbanBoard', () => ({
  default: function MockKanbanBoard(p: any) {
    ctl.boardProps = p;
    return (
      <div
        data-testid="kanban-board"
        data-project={String(p.projectId)}
        data-focus-card={p.focusCardId == null ? '' : String(p.focusCardId)}
      />
    );
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
  return {
    ...mod,
    api: {
      ...mod.api,
      getModelConfig: vi
        .fn()
        .mockResolvedValue({ engineDefaultModels: { 'claude-code': 'claude-opus-4-8' } }),
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
    agents: [{ id: 'agent-1', name: 'A1', color: '#3b82f6', engine: 'claude-code' }],
  },
];

const SESSIONS = [{ id: 'sess-1', name: 'A session', engine: 'claude-code', agent_id: 'agent-1' }];

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

async function bootApp() {
  render(<App />);
  await waitFor(() => expect(typeof ctl.resolveProjects).toBe('function'), { timeout: 3000 });
  await act(async () => {
    ctl.resolveProjects(PROJECT_FIXTURE);
  });
  await waitFor(() => expect(typeof ctl.resolveSessionsByAgent['agent-1']).toBe('function'), {
    timeout: 3000,
  });
  await act(async () => {
    ctl.resolveSessionsByAgent['agent-1'](SESSIONS);
  });
}

describe('App — ticket links focus the specific card', () => {
  const origElectron = globalThis.window.electronAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    globalThis.window.electronAPI = undefined;
    mockFetch();
    ctl.resolveProjects = null;
    ctl.resolveSessionsByAgent = {};
    ctl.boardProps = null;
    ctl.sidebarProps = null;
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState(null, '', '/');
    globalThis.window.electronAPI = origElectron;
  });

  it('Session Summary "open ticket" opens the board with that card focused', async () => {
    localStorage.setItem('activeAgentId', 'agent-1');
    window.history.replaceState(null, '', '/');

    await bootApp();

    // Select the session so the chat view (with the summary sidebar) mounts.
    await waitFor(() => expect(ctl.sidebarProps).not.toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByTestId('mock-select-session'));
    });

    const openTicket = await screen.findByTestId('mock-summary-open-card');
    await act(async () => {
      fireEvent.click(openTicket);
    });

    await waitFor(() => expect(ctl.boardProps).not.toBeNull());
    expect(ctl.boardProps.projectId).toBe('proj-1');
    expect(ctl.boardProps.focusCardId).toBe('card-42');
  });

  it('Pull Requests linked card opens the board with that card focused', async () => {
    window.history.replaceState(null, '', '/projects/proj-1/pulls');

    await bootApp();

    const openCard = await screen.findByTestId('mock-pr-open-card');
    await act(async () => {
      fireEvent.click(openCard);
    });

    await waitFor(() => expect(ctl.boardProps).not.toBeNull());
    expect(ctl.boardProps.projectId).toBe('proj-1');
    expect(ctl.boardProps.focusCardId).toBe('card-xyz');
  });
});
