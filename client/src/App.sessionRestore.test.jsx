/**
 * App: restoring `activeSessionId` from localStorage on mount.
 *
 * Regression test for the "Claude session sometimes drops — user loses
 * context" bug. Before the fix, `activeSessionId` was state-only; an Electron
 * reload / app restart would silently pick `data[0]` (the session with the
 * newest `updated_at`), which could be an unrelated cron or heartbeat row —
 * users experienced this as "my session disappeared".
 *
 * After the fix, `activeSessionId` is persisted under
 * `activeSessionId:<agentId>` and restored on mount when the session still
 * exists in the live list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, cleanup } from '@testing-library/react';

const ctl = vi.hoisted(() => ({
  resolveProjects: null,
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
      globalThis.__ahActiveSessionIdFromSidebar = p.activeSessionId;
    }
    return <div data-testid="sidebar-restore" data-active-session-id={p.activeSessionId || ''} />;
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
  const empty = { engineDefaultModels: { 'claude-code': 'claude-opus-4-8' } };
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
      getDesigns: vi.fn().mockResolvedValue([]),
      getCronSessions: vi.fn().mockResolvedValue([]),
      getMessages: vi
        .fn()
        .mockResolvedValue([{ id: 'm-x', role: 'user', content: 'hi', created_at: '' }]),
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

// Simulates the server returning sessions ordered by `updated_at DESC`:
// s-newest is first, s-user-was-on is older. Before the fix the client
// silently picked s-newest on mount.
const SESSIONS = [
  { id: 's-newest', name: 'Newest (cron)', engine: 'claude-code' },
  { id: 's-user-was-on', name: 'What the user was working on', engine: 'claude-code' },
];

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

async function bootstrapAgent() {
  await waitFor(() => expect(typeof ctl.resolveProjects).toBe('function'), { timeout: 3000 });
  await act(async () => {
    ctl.resolveProjects(PROJECT_FIXTURE);
  });
  await waitFor(() => expect(typeof ctl.resolveSessionsByAgent['agent-1']).toBe('function'), {
    timeout: 3000,
  });
}

describe('App — activeSessionId persistence / restore', () => {
  const origElectron = globalThis.window.electronAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    ctl.resolveProjects = null;
    ctl.resolveSessionsByAgent = {};
    localStorage.clear();
    globalThis.window.electronAPI = undefined;
    mockFetch();
    delete globalThis.__ahActiveSessionIdFromSidebar;
  });

  afterEach(() => {
    cleanup();
    globalThis.window.electronAPI = origElectron;
  });

  it('restores the previously-active session for an agent from localStorage', async () => {
    localStorage.setItem('activeAgentId', 'agent-1');
    localStorage.setItem('activeSessionId:agent-1', 's-user-was-on');

    render(<App />);
    await bootstrapAgent();

    await act(async () => {
      ctl.resolveSessionsByAgent['agent-1'](SESSIONS);
    });

    await waitFor(() => expect(globalThis.__ahActiveSessionIdFromSidebar).toBe('s-user-was-on'));
  });

  it('falls back to data[0] (newest) when no session is remembered', async () => {
    localStorage.setItem('activeAgentId', 'agent-1');
    // No activeSessionId key stored — simulates first-run / post-clear.

    render(<App />);
    await bootstrapAgent();

    await act(async () => {
      ctl.resolveSessionsByAgent['agent-1'](SESSIONS);
    });

    await waitFor(() => expect(globalThis.__ahActiveSessionIdFromSidebar).toBe('s-newest'));
  });

  it('falls back to data[0] when the remembered session no longer exists (e.g. deleted)', async () => {
    localStorage.setItem('activeAgentId', 'agent-1');
    localStorage.setItem('activeSessionId:agent-1', 's-long-gone');

    render(<App />);
    await bootstrapAgent();

    await act(async () => {
      ctl.resolveSessionsByAgent['agent-1'](SESSIONS);
    });

    await waitFor(() => expect(globalThis.__ahActiveSessionIdFromSidebar).toBe('s-newest'));
  });

  it('writes activeSessionId to localStorage whenever a session becomes active', async () => {
    localStorage.setItem('activeAgentId', 'agent-1');

    render(<App />);
    await bootstrapAgent();

    await act(async () => {
      ctl.resolveSessionsByAgent['agent-1'](SESSIONS);
    });

    // After the auto-select picks `data[0]` the effect should have written it.
    await waitFor(() => expect(localStorage.getItem('activeSessionId:agent-1')).toBe('s-newest'));
  });
});
