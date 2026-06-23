/**
 * App integration: the Notes sidebar link highlights for the active notes
 * project only because App threads its `notesProjectId` state down to
 * <Sidebar notesProjectId={...}> (mirrors threadsProjectId / pullsProjectId).
 *
 * Regression guard: a reviewer worried the prop might never be wired at the
 * caller, leaving the Notes row un-highlighted in the real app. This test
 * renders the real App (Sidebar mocked only to capture props), navigates to the
 * notes view via the same onNavigate the link uses, and asserts App passes the
 * project id through. It would fail if App stopped wiring notesProjectId.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, cleanup } from '@testing-library/react';

const ctl = vi.hoisted(() => ({
  resolveProjects: null as any,
  /** @type {Record<string, (value: unknown) => void>} */
  resolveSessionsByAgent: {} as Record<string, any> as Record<string, any> as Record<string, any>,
  /** latest props the real App passed to <Sidebar> */
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

(vi as any).mock('./components/Sidebar.jsx', () => ({
  default: function MockSidebar(p: any) {
    ctl.sidebarProps = p;
    return (
      <div
        data-testid="sidebar-notes-wiring"
        data-notes-project={p.notesProjectId == null ? '' : String(p.notesProjectId)}
      />
    );
  },
}));

(vi as any).mock('./components/NotesEditor.jsx', () => ({
  default: function MockNotesEditor(p: any) {
    return <div data-testid="notes-editor" data-project={String(p.projectId)} />;
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

describe('App — Notes sidebar prop wiring', () => {
  const origElectron = globalThis.window.electronAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    globalThis.window.electronAPI = undefined;
    mockFetch();
    ctl.resolveProjects = null;
    ctl.resolveSessionsByAgent = {};
    ctl.sidebarProps = null;
  });

  afterEach(() => {
    cleanup();
    globalThis.window.electronAPI = origElectron;
  });

  it('threads notesProjectId to Sidebar after navigating to the notes view', async () => {
    const { getByTestId } = render(<App />);

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

    // Sidebar mounted and App is the one supplying its props.
    await waitFor(() => expect(ctl.sidebarProps).not.toBeNull());
    // Before navigating, no notes project is active.
    expect(getByTestId('sidebar-notes-wiring')).toHaveAttribute('data-notes-project', '');
    expect(typeof ctl.sidebarProps!.onNavigate).toBe('function');

    // Drive the exact navigation the Notes link performs.
    await act(async () => {
      ctl.sidebarProps!.onNavigate('notes', 'proj-1');
    });

    // App must have threaded its notesProjectId state down to Sidebar.
    await waitFor(() => {
      expect(getByTestId('sidebar-notes-wiring')).toHaveAttribute('data-notes-project', 'proj-1');
    });
    expect(ctl.sidebarProps!.notesProjectId).toBe('proj-1');
  });
});
