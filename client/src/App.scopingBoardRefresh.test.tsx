import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, cleanup, fireEvent } from '@testing-library/react';

const ctl = vi.hoisted(() => ({
  resolveProjects: null as any,
  resolveSessionsByAgent: {} as Record<string, any>,
  wsHandler: null as any,
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
    return <div data-testid="sidebar" />;
  },
}));

// Capture the WS message handler App passes to useWebSocket so the test can
// drive kanban_update events straight into the real handler.
(vi as any).mock('./hooks/useWebSocket.js', () => ({
  useWebSocket: (handler: any) => {
    ctl.wsHandler = handler;
    return { send: vi.fn(), connected: true, reconnecting: false, wsRef: { current: null } };
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
      getBoard: vi.fn(),
      getArchivedSessions: vi.fn().mockResolvedValue([]),
      getSkills: vi.fn().mockResolvedValue([]),
      getDesigns: vi.fn().mockResolvedValue([]),
      getCronSessions: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockResolvedValue([]),
      getSessionHandoffs: vi.fn().mockResolvedValue([]),
      getSessionProgress: vi.fn().mockResolvedValue({ steps: [] }),
      getSecurityFindings: vi.fn().mockResolvedValue([]),
      getProjectPulls: vi.fn().mockResolvedValue([]),
      ensureSessionWorkspace: vi.fn().mockResolvedValue({ ok: true, skipped: true } as any),
    },
  };
});

const SCOPING_SESSION = {
  id: 's-1',
  name: 'Scope',
  agent_id: 'agent-1',
  engine: 'claude-code',
  session_mode: 'scoping',
  linked_epic_id: null,
};
const EMPTY_BOARD = { columns: [], cards: [], epics: [], phases: [], specItems: [] };

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

async function bootApp() {
  render(<App initialView="chat" />);
  await waitFor(() => expect(typeof ctl.resolveProjects).toBe('function'), { timeout: 3000 });
  await act(async () => {
    ctl.resolveProjects(PROJECT_FIXTURE);
  });
  await waitFor(() => expect(typeof ctl.resolveSessionsByAgent['agent-1']).toBe('function'), {
    timeout: 3000,
  });
  await act(async () => {
    ctl.resolveSessionsByAgent['agent-1']([SCOPING_SESSION]);
  });
  await waitFor(() => expect(typeof ctl.wsHandler).toBe('function'), { timeout: 3000 });
}

describe('App scoping board refresh', () => {
  const origElectron = globalThis.window.electronAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getBoard).mockResolvedValue(EMPTY_BOARD as any);
    localStorage.clear();
    globalThis.window.electronAPI = undefined;
    mockFetch();
    ctl.resolveProjects = null;
    ctl.resolveSessionsByAgent = {};
    ctl.wsHandler = null;
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    window.history.replaceState(null, '', '/');
    globalThis.window.electronAPI = origElectron;
  });

  it('selects and shows the newly linked feature without leaving the session', async () => {
    await bootApp();
    const select = await screen.findByTestId('scoping-epic-select');
    await waitFor(() => expect(api.getBoard).toHaveBeenCalledTimes(1));
    expect(select).toHaveValue('');
    const scopedBoard = {
      ...EMPTY_BOARD,
      epics: [{ id: 'e-1', name: 'Project Autopilot', color: '#6366F1' }],
      phases: [{ id: 'phase-1', epic_id: 'e-1', name: 'Initial build', position: 0 }],
      specItems: [
        {
          id: 'spec-1',
          epic_id: 'e-1',
          tag: 'storage',
          title: 'Where to store data?',
          status: 'chosen',
          decision: 'Use local files',
        },
      ],
    };
    vi.mocked(api.getBoard).mockResolvedValue(scopedBoard as any);

    await act(async () => {
      ctl.wsHandler({
        type: 'session-updated',
        session: { ...SCOPING_SESSION, linked_epic_id: 'e-1' },
      });
      ctl.wsHandler({ type: 'kanban_update', projectId: 'proj-1' });
    });

    await waitFor(() => expect(select).toHaveValue('e-1'));
    expect(screen.getByRole('option', { name: 'Project Autopilot' })).toBeInTheDocument();
    expect(screen.getByTestId('scoping-open-epic')).toBeInTheDocument();
    expect(screen.getByTestId('epic-scope-workbench')).toBeInTheDocument();
    expect(api.getBoard).toHaveBeenLastCalledWith('proj-1', { limit: 'all' });
    expect(screen.getByTestId('phase-column-phase-1')).toHaveTextContent('Initial build');
    fireEvent.click(screen.getByTestId('scope-tab-spec'));
    expect(screen.getByTestId('spec-item-spec-1')).toHaveTextContent('Use local files');

    vi.mocked(api.getBoard).mockResolvedValue({
      ...scopedBoard,
      phases: [{ ...scopedBoard.phases[0], name: 'Build persistence' }],
      specItems: [{ ...scopedBoard.specItems[0], decision: 'Use SQLite' }],
    } as any);
    await act(async () => {
      ctl.wsHandler({ type: 'kanban_update', projectId: 'proj-1' });
    });

    await waitFor(() =>
      expect(screen.getByTestId('spec-item-spec-1')).toHaveTextContent('Use SQLite'),
    );
    expect(screen.getByTestId('spec-item-spec-1')).not.toHaveTextContent('Use local files');
    fireEvent.click(screen.getByTestId('scope-tab-flowchart'));
    expect(screen.getByTestId('phase-column-phase-1')).toHaveTextContent('Build persistence');
    expect(screen.getByTestId('phase-column-phase-1')).not.toHaveTextContent('Initial build');
    expect(select).toHaveValue('e-1');
    expect(api.getBoard).toHaveBeenCalledTimes(3);
    expect(api.getMessages).toHaveBeenCalledTimes(1);
  });

  it('ignores other projects and coalesces updates for the active scoping project', async () => {
    await bootApp();
    await screen.findByTestId('scoping-epic-select');
    await waitFor(() => expect(api.getBoard).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();

    await act(async () => {
      ctl.wsHandler({ type: 'kanban_update', projectId: 'other-project' });
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(api.getBoard).toHaveBeenCalledTimes(1);

    await act(async () => {
      for (let i = 0; i < 20; i++) {
        ctl.wsHandler({ type: 'kanban_update', projectId: 'proj-1' });
      }
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(api.getBoard).toHaveBeenCalledTimes(2);

    await act(async () => {
      ctl.wsHandler({
        type: 'session-updated',
        session: { ...SCOPING_SESSION, session_mode: 'chat' },
      });
    });
    expect(screen.queryByTestId('scoping-epic-select')).not.toBeInTheDocument();
    await act(async () => {
      ctl.wsHandler({ type: 'kanban_update', projectId: 'proj-1' });
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(api.getBoard).toHaveBeenCalledTimes(2);
  });
});
