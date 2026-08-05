/**
 * App integration: a pasted PR path link opens that PR.
 *
 * `https://hub.example.com/projects/acme/pulls/306` is the URL people copy out
 * of the address bar and share. The app routes on the hash, so before this
 * wiring the path was ignored and the visitor landed on the dashboard (the bug
 * report even shows the hybrid `/projects/acme/pulls/306#/pulls/acme` URL the
 * old build produced). This test renders the real App on that path and asserts
 * both halves of the fix: the PR opens, and the URL collapses to the canonical
 * hash so the next refresh keeps working.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, cleanup } from '@testing-library/react';

const ctl = vi.hoisted(() => ({
  resolveProjects: null as any,
  resolveSessionsByAgent: {} as Record<string, any>,
  pullsProps: null as any,
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

(vi as any).mock('./components/PullRequestsPage.jsx', () => ({
  default: function MockPullRequestsPage(p: any) {
    ctl.pullsProps = p;
    return (
      <div
        data-testid="pulls-page"
        data-project={String(p.projectId)}
        data-pr={p.initialPrNumber == null ? '' : String(p.initialPrNumber)}
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
      getProjectPulls: vi.fn().mockResolvedValue({ pulls: [], hasMore: false }),
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
}

describe('App — PR path deep link', () => {
  const origElectron = globalThis.window.electronAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    globalThis.window.electronAPI = undefined;
    mockFetch();
    ctl.resolveProjects = null;
    ctl.resolveSessionsByAgent = {};
    ctl.pullsProps = null;
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState(null, '', '/');
    globalThis.window.electronAPI = origElectron;
  });

  it('opens the PR named in the path and rewrites the URL to the canonical hash', async () => {
    window.history.replaceState(null, '', '/projects/proj-1/pulls/306');

    await bootApp();

    await waitFor(() => expect(ctl.pullsProps).not.toBeNull());
    expect(ctl.pullsProps.projectId).toBe('proj-1');
    expect(ctl.pullsProps.initialPrNumber).toBe(306);
    await waitFor(() => expect(window.location.hash).toBe('#/pulls/proj-1?pr=306'));
    // The stale path is gone, so a refresh routes off the hash alone.
    expect(window.location.pathname).toBe('/');
  });

  it('recovers the PR number from the hybrid path+hash URL older builds produced', async () => {
    window.history.replaceState(null, '', '/projects/proj-1/pulls/306#/pulls/proj-1');

    await bootApp();

    await waitFor(() => expect(ctl.pullsProps).not.toBeNull());
    expect(ctl.pullsProps.initialPrNumber).toBe(306);
    await waitFor(() => expect(window.location.hash).toBe('#/pulls/proj-1?pr=306'));
  });

  it('keeps the PR number in the URL when the page reports a selection', async () => {
    window.history.replaceState(null, '', '/#/pulls/proj-1');

    await bootApp();

    await waitFor(() => expect(ctl.pullsProps).not.toBeNull());
    expect(ctl.pullsProps.initialPrNumber).toBeNull();

    await act(async () => {
      ctl.pullsProps.onPrNumberChange(42);
    });
    await waitFor(() => expect(window.location.hash).toBe('#/pulls/proj-1?pr=42'));

    await act(async () => {
      ctl.pullsProps.onPrNumberChange(null);
    });
    await waitFor(() => expect(window.location.hash).toBe('#/pulls/proj-1'));
  });
});
