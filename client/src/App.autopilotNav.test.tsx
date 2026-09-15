import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, cleanup } from '@testing-library/react';

const ctl = vi.hoisted(() => ({
  resolveProjects: null as any,
  resolveSessionsByAgent: {} as Record<string, any>,
  onNavigate: null as any,
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

// Capture the onNavigate callback App wires into the Sidebar so the test can
// drive a real sidebar navigation (the click handler that regressed).
(vi as any).mock('./components/Sidebar.jsx', () => ({
  default: function MockSidebar(props: any) {
    ctl.onNavigate = props.onNavigate;
    return <div data-testid="sidebar" />;
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
      getBoard: vi.fn().mockResolvedValue({
        columns: [],
        cards: [],
        epics: [],
        phases: [],
        specItems: [],
      }),
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
      // AutopilotSettingsSection refetches on mount; a resolved wire state lets
      // it render its section shell (deriveAutopilotView needs config.target).
      getAutopilot: vi.fn().mockResolvedValue({
        config: {
          projectId: 'proj-1',
          enabled: false,
          disabling: false,
          briefId: 'b1',
          brief: 'Build a todo app.',
          briefRevision: 1,
          target: {
            targetId: 'local',
            origin: 'http://127.0.0.1:8080',
            readinessProbeUrl: 'http://127.0.0.1:8080/health',
          },
          limits: {
            cycleMode: 'continuous',
            maxCycles: null,
            maxWallTimeMs: 4 * 60 * 60 * 1000,
            maxStageTimeoutMs: 30 * 60 * 1000,
            maxRetriesPerStage: 2,
            maxCostUsd: null,
          },
          credentialOwnerUserId: 'user-1',
          updatedAt: '2026-09-15T00:00:00.000Z',
          updatedBy: 'user-1',
        },
        activeRun: null,
      }),
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
  render(<App initialView="chat" />);
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
  await waitFor(() => expect(typeof ctl.onNavigate).toBe('function'), { timeout: 3000 });
}

describe('App autopilot sidebar navigation', () => {
  const origElectron = globalThis.window.electronAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    globalThis.window.electronAPI = undefined;
    mockFetch();
    ctl.resolveProjects = null;
    ctl.resolveSessionsByAgent = {};
    ctl.onNavigate = null;
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    window.history.replaceState(null, '', '/');
    globalThis.window.electronAPI = origElectron;
  });

  // Regression: onNavigate set currentView='autopilot' but never set
  // autopilotProjectId, so the render guard failed and the Autopilot click
  // fell through to a blank session pane.
  it('renders the autopilot section (not a blank pane) when navigating to autopilot', async () => {
    await bootApp();
    await act(async () => {
      ctl.onNavigate('autopilot', 'proj-1');
    });
    await waitFor(() => expect(screen.getByTestId('autopilot-section')).toBeInTheDocument());
  });
});
