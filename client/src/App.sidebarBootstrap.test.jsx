/**
 * App integration: sidebar `isLoading` should stay true through (1) projects
 * fetch and (2) sessions fetch, so the nav can show a spinner while the main
 * chat column is already mounted after org bootstrap. Uses deferred promises to
 * assert ordering without timing flakes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, cleanup } from '@testing-library/react';

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
    if (typeof globalThis !== 'undefined' && p.onSelectAgent) {
      globalThis.__ahTestSelectAgent = p.onSelectAgent;
    }
    return (
      <div
        data-testid="sidebar-bootstrap"
        data-is-loading={p.isLoading ? 'true' : 'false'}
        aria-label={p.isLoading ? 'sidebar loading' : 'sidebar ready'}
      />
    );
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
      getMessages: vi.fn().mockResolvedValue([]),
      getSessionHandoffs: vi.fn().mockResolvedValue([]),
      getSessionProgress: vi.fn().mockResolvedValue({ steps: [] }),
      ensureSessionWorkspace: vi.fn().mockResolvedValue({ ok: true, skipped: true }),
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

const TWO_AGENT_FIXTURE = [
  {
    id: 'proj-1',
    name: 'Project',
    color: '#3b82f6',
    cwd: '/tmp/w',
    ahw: '/tmp/w',
    agents: [
      { id: 'agent-1', name: 'A1', color: '#3b82f6', engine: 'claude-code' },
      { id: 'agent-2', name: 'A2', color: '#3b82f6', engine: 'claude-code' },
    ],
  },
];

import App from './App.jsx';
import { api } from './utils/api.js';

function mockFetch() {
  globalThis.fetch = vi.fn((url) => {
    const u = String(url);
    if (u.includes('/setup/status')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ firstRun: false }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

describe('App — sidebar loading vs projects/sessions', () => {
  const origElectron = globalThis.window.electronAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear everything so per-agent `activeSessionId` keys written by earlier
    // tests don't leak into later ones and hijack session auto-select.
    localStorage.clear();
    globalThis.window.electronAPI = undefined;
    mockFetch();
    ctl.resolveProjects = null;
    ctl.resolveSessionsByAgent = {};
    delete globalThis.__ahTestSelectAgent;
  });

  afterEach(() => {
    cleanup();
    globalThis.window.electronAPI = origElectron;
  });

  it('keeps sidebar isLoading true until getSessions resolves after getProjects', async () => {
    const { getByTestId } = render(<App />);
    const side = () => getByTestId('sidebar-bootstrap');

    await waitFor(
      () => {
        expect(typeof ctl.resolveProjects).toBe('function');
      },
      { timeout: 3000 },
    );
    // Org bootstrap has finished: not the full-screen gate, but projects still in flight
    expect(side()).toHaveAttribute('data-is-loading', 'true');

    await act(async () => {
      ctl.resolveProjects(PROJECT_FIXTURE);
    });

    await waitFor(
      () => {
        expect(typeof ctl.resolveSessionsByAgent['agent-1']).toBe('function');
      },
      { timeout: 3000 },
    );
    // Projects are ready, sessions list still loading
    expect(side()).toHaveAttribute('data-is-loading', 'true');

    await act(async () => {
      ctl.resolveSessionsByAgent['agent-1']([]);
    });

    await waitFor(() => {
      expect(side()).toHaveAttribute('data-is-loading', 'false');
    });
  });

  it('does not clear session loading on stale getSessions if activeAgentId changes (race)', async () => {
    const { getByTestId } = render(<App />);
    const side = () => getByTestId('sidebar-bootstrap');

    await waitFor(
      () => {
        expect(typeof ctl.resolveProjects).toBe('function');
      },
      { timeout: 3000 },
    );
    expect(side()).toHaveAttribute('data-is-loading', 'true');

    await act(async () => {
      ctl.resolveProjects(TWO_AGENT_FIXTURE);
    });

    await waitFor(
      () => {
        expect(typeof ctl.resolveSessionsByAgent['agent-1']).toBe('function');
      },
      { timeout: 3000 },
    );
    expect(api.getSessions).toHaveBeenCalledWith('agent-1');
    expect(side()).toHaveAttribute('data-is-loading', 'true');

    expect(typeof globalThis.__ahTestSelectAgent).toBe('function');
    await act(async () => {
      globalThis.__ahTestSelectAgent('agent-2');
    });

    await waitFor(
      () => {
        expect(api.getSessions).toHaveBeenCalledWith('agent-2');
      },
      { timeout: 3000 },
    );
    expect(side()).toHaveAttribute('data-is-loading', 'true');

    await act(async () => {
      ctl.resolveSessionsByAgent['agent-1']([]);
    });
    expect(side()).toHaveAttribute('data-is-loading', 'true');

    const sessionRowB = { id: 's-b', name: 'SB', engine: 'claude-code' };
    await act(async () => {
      ctl.resolveSessionsByAgent['agent-2']([sessionRowB]);
    });

    await waitFor(() => {
      expect(side()).toHaveAttribute('data-is-loading', 'false');
    });
  });

  it('does not snap back to prior agent when switching with an active session', async () => {
    render(<App />);

    await waitFor(
      () => {
        expect(typeof ctl.resolveProjects).toBe('function');
      },
      { timeout: 3000 },
    );
    await act(async () => {
      ctl.resolveProjects(TWO_AGENT_FIXTURE);
    });

    await waitFor(
      () => {
        expect(typeof ctl.resolveSessionsByAgent['agent-1']).toBe('function');
      },
      { timeout: 3000 },
    );
    await act(async () => {
      ctl.resolveSessionsByAgent['agent-1']([{ id: 's-a', name: 'SA', engine: 'claude-code' }]);
    });

    const callsBefore = api.getSessions.mock.calls.length;
    await act(async () => {
      globalThis.__ahTestSelectAgent('agent-2');
    });
    await waitFor(
      () => {
        expect(typeof ctl.resolveSessionsByAgent['agent-2']).toBe('function');
      },
      { timeout: 3000 },
    );
    expect(api.getSessions).toHaveBeenLastCalledWith('agent-2');

    await act(async () => {
      ctl.resolveSessionsByAgent['agent-2']([]);
    });
    await waitFor(() => {
      expect(api.getSessions.mock.calls.length).toBe(callsBefore + 1);
    });
  });
});
