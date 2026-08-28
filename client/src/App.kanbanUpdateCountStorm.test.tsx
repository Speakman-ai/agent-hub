/**
 * App integration: a burst of kanban_update WS events must not fan out into one
 * count-refresh request per event.
 *
 * The board-dead bug: a security scan (or an autonomous agent moving many cards)
 * broadcasts a rapid burst of `kanban_update` events. Each event fired an
 * unthrottled, undeduped GET /security-audit/findings?status=open AND
 * /pulls — dozens/hundreds of concurrent requests that exhausted the browser
 * socket pool (net::ERR_INSUFFICIENT_RESOURCES) and starved the board load, so
 * the board showed "Failed to load board".
 *
 * This renders the real App, captures the WS handler, and fires a synchronous
 * burst of kanban_update events for one project while the current view is NOT
 * the Security view. With per-project coalescing, all concurrent events share a
 * single in-flight fetch, so each endpoint is hit exactly once. Without it, the
 * fetch count equals the burst size — the storm this test guards against.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, cleanup } from '@testing-library/react';

const ctl = vi.hoisted(() => ({
  resolveProjects: null as any,
  resolveSessionsByAgent: {} as Record<string, any>,
  wsHandler: null as any,
  securityFindingsCalls: 0,
  projectPullsCalls: 0,
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
      getArchivedSessions: vi.fn().mockResolvedValue([]),
      getSkills: vi.fn().mockResolvedValue([]),
      getDesigns: vi.fn().mockResolvedValue([]),
      getCronSessions: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockResolvedValue([]),
      getSessionHandoffs: vi.fn().mockResolvedValue([]),
      getSessionProgress: vi.fn().mockResolvedValue({ steps: [] }),
      // Never-resolving so the first burst fetch stays in-flight for the whole
      // synchronous burst; that is exactly when coalescing must collapse them.
      getSecurityFindings: vi.fn(() => {
        ctl.securityFindingsCalls += 1;
        return new Promise(() => {});
      }),
      getProjectPulls: vi.fn(() => {
        ctl.projectPullsCalls += 1;
        return new Promise(() => {});
      }),
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
    // Enable the pulls badge path so refreshOpenPullCount runs on kanban_update.
    gitHost: 'agenthub',
    agents: [{ id: 'agent-1', name: 'A1', color: '#3b82f6', engine: 'claude-code' }],
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
    ctl.resolveSessionsByAgent['agent-1']([]);
  });
  await waitFor(() => expect(typeof ctl.wsHandler).toBe('function'), { timeout: 3000 });
}

describe('App — kanban_update count-refresh storm', () => {
  const origElectron = globalThis.window.electronAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    globalThis.window.electronAPI = undefined;
    mockFetch();
    ctl.resolveProjects = null;
    ctl.resolveSessionsByAgent = {};
    ctl.wsHandler = null;
    ctl.securityFindingsCalls = 0;
    ctl.projectPullsCalls = 0;
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState(null, '', '/');
    globalThis.window.electronAPI = origElectron;
  });

  it('coalesces a burst of kanban_update events into one findings + one pulls fetch', async () => {
    await bootApp();

    // Ignore any one-time cold-load seed fetches; measure only the burst.
    const findingsBefore = ctl.securityFindingsCalls;
    const pullsBefore = ctl.projectPullsCalls;

    // Fire the burst synchronously so every event lands while the first fetch is
    // still in-flight — the precise condition that used to open one socket each.
    await act(async () => {
      for (let i = 0; i < 50; i++) {
        ctl.wsHandler({ type: 'kanban_update', projectId: 'proj-1' });
      }
    });

    expect(ctl.securityFindingsCalls - findingsBefore).toBe(1);
    expect(ctl.projectPullsCalls - pullsBefore).toBe(1);
  });
});
