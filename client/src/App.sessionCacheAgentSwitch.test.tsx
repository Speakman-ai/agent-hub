/**
 * App integration: the sidebar per-agent session cache must never be stamped
 * with the wrong agent's rows during an agent switch. React can render with the
 * new `activeAgentId` while `sessions` still holds the previous agent's list
 * (the new fetch hasn't resolved). The cache warm-up must key on the agent the
 * rows were FETCHED for, not on `activeAgentId`. Uses deferred promises to drive
 * the race deterministically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, cleanup } from '@testing-library/react';

const ctl = vi.hoisted(() => ({
  resolveProjects: null as any,
  resolveSessionsByAgent: {} as Record<string, any>,
  lastSidebarProps: null as any,
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
    ctl.lastSidebarProps = p;
    if (typeof globalThis !== 'undefined' && p.onSelectAgent) {
      (globalThis as any).__ahTestSelectAgent = p.onSelectAgent;
    }
    return <div data-testid="sidebar-cache" />;
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
(vi as any).mock('./hooks/useKeyboardShortcuts.js', () => ({ useKeyboardShortcuts: () => {} }));
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
      getMessages: vi.fn().mockResolvedValue([]),
      getSessionHandoffs: vi.fn().mockResolvedValue([]),
      getSessionProgress: vi.fn().mockResolvedValue({ steps: [] }),
      ensureSessionWorkspace: vi.fn().mockResolvedValue({ ok: true, skipped: true } as any),
    },
  };
});

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

describe('App — per-agent session cache during agent switch', () => {
  const origElectron = globalThis.window.electronAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    globalThis.window.electronAPI = undefined;
    mockFetch();
    ctl.resolveProjects = null;
    ctl.resolveSessionsByAgent = {};
    ctl.lastSidebarProps = null;
    delete (globalThis as any).__ahTestSelectAgent;
  });

  afterEach(() => {
    cleanup();
    globalThis.window.electronAPI = origElectron;
  });

  it('does not stamp agent-1 rows under agent-2 while agent-2 sessions are still loading', async () => {
    render(<App />);

    await waitFor(() => expect(typeof ctl.resolveProjects).toBe('function'), { timeout: 3000 });
    await act(async () => {
      ctl.resolveProjects(TWO_AGENT_FIXTURE);
    });

    // agent-1 loads with one session row.
    await waitFor(() => expect(typeof ctl.resolveSessionsByAgent['agent-1']).toBe('function'), {
      timeout: 3000,
    });
    const rowA = { id: 's-a', name: 'SA', engine: 'claude-code' };
    await act(async () => {
      ctl.resolveSessionsByAgent['agent-1']([rowA]);
    });

    await waitFor(() =>
      expect(ctl.lastSidebarProps?.sessionsByAgentId?.['agent-1']).toEqual([rowA]),
    );

    // Switch to agent-2; its fetch is in flight (not resolved). `sessions` still
    // holds agent-1's rows at this moment.
    await act(async () => {
      (globalThis as any).__ahTestSelectAgent('agent-2');
    });
    await waitFor(() => expect(typeof ctl.resolveSessionsByAgent['agent-2']).toBe('function'), {
      timeout: 3000,
    });

    // BUG GUARD: the cache for agent-2 must NOT have been filled with agent-1's
    // rows by the warm-up effect. It should be empty/undefined until agent-2's
    // fetch resolves.
    const cacheForB = ctl.lastSidebarProps?.sessionsByAgentId?.['agent-2'];
    expect(cacheForB === undefined || cacheForB.length === 0).toBe(true);
    if (Array.isArray(cacheForB)) {
      expect(cacheForB.some((s: any) => s.id === 's-a')).toBe(false);
    }

    // Resolve agent-2 with its own rows; now each agent's cache is correct.
    const rowB = { id: 's-b', name: 'SB', engine: 'claude-code' };
    await act(async () => {
      ctl.resolveSessionsByAgent['agent-2']([rowB]);
    });

    await waitFor(() =>
      expect(ctl.lastSidebarProps?.sessionsByAgentId?.['agent-2']).toEqual([rowB]),
    );
    // agent-1's cache is untouched and still correct.
    expect(ctl.lastSidebarProps?.sessionsByAgentId?.['agent-1']).toEqual([rowA]);
  });
});
