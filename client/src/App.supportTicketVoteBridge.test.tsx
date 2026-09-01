/**
 * App integration: the server's `support_ticket_vote_updated` WebSocket message
 * must be bridged to the `agenthub-support-ticket-vote` window event that the
 * Customer Support Voting tab listens for. Without this bridge, real server
 * vote broadcasts never reach VotingTab (which only subscribes to the window
 * event), so live score reconcile would silently never fire.
 *
 * This renders the real App, captures the WS handler App passes to
 * useWebSocket, feeds a vote message straight into it, and asserts the window
 * event is dispatched with the server payload intact.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, cleanup } from '@testing-library/react';

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
// drive a support_ticket_vote_updated message straight into the real handler.
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

describe('App — support_ticket_vote_updated WS bridge', () => {
  const origElectron = globalThis.window.electronAPI;

  beforeEach(() => {
    vi.clearAllMocks();
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
    window.history.replaceState(null, '', '/');
    globalThis.window.electronAPI = origElectron;
  });

  it('re-dispatches a server vote message as the agenthub-support-ticket-vote window event', async () => {
    await bootApp();

    const received: any[] = [];
    const listener = (e: any) => received.push(e.detail);
    window.addEventListener('agenthub-support-ticket-vote', listener);

    const payload = {
      type: 'support_ticket_vote_updated',
      ticketId: 'ticket-42',
      projectId: 'proj-1',
      score: 7,
      upvotes: 8,
      downvotes: 1,
    };

    await act(async () => {
      ctl.wsHandler(payload);
    });

    window.removeEventListener('agenthub-support-ticket-vote', listener);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: 'support_ticket_vote_updated',
      ticketId: 'ticket-42',
      projectId: 'proj-1',
      score: 7,
      upvotes: 8,
      downvotes: 1,
    });
  });
});
