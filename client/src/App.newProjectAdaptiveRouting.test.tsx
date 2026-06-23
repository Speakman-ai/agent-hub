/**
 * App integration: the primary "+ New Project" CTA must route to the
 * adaptive (prompt-first) wizard, not the legacy folder-picker wizard.
 *
 * This test mocks Sidebar and NewProjectAdaptiveFlow so we can assert the
 * view-switch through the CTA callback, and that the flow unmounts when
 * `onClose` fires.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, cleanup, screen } from '@testing-library/react';

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

// Capture the CTA handler so the test can trigger it directly, and
// surface current view via a data attribute so assertions stay
// deterministic.
(vi as any).mock('./components/Sidebar.jsx', () => ({
  default: function MockSidebar(p: any) {
    if (typeof globalThis !== 'undefined' && p.onOpenProject) {
      (globalThis as any).__ahNewProjectCTA = p.onOpenProject;
    }
    return (
      <div
        data-testid="sidebar-mock"
        data-current-view={p.currentView || ''}
        data-has-cta={p.onOpenProject ? 'true' : 'false'}
      />
    );
  },
}));

// Intercept NewProjectAdaptiveFlow so we can (a) assert it mounts when
// the adaptive view is active, (b) trigger `onClose` to verify the
// unmount path, and (c) trigger `onProjectCreated` to verify action routing.
(vi as any).mock('./components/NewProjectAdaptiveFlow.jsx', () => ({
  default: function MockAdaptiveFlow(p: any) {
    if (typeof globalThis !== 'undefined') {
      (globalThis as any).__ahAdaptiveOnClose = p.onClose;
      (globalThis as any).__ahAdaptiveOnProjectCreated = p.onProjectCreated;
    }
    return <div data-testid="adaptive-flow-mock" />;
  },
}));

(vi as any).mock('./components/KanbanBoard.jsx', () => ({
  default: function MockKanbanBoard() {
    return <div data-testid="kanban-board-mock" />;
  },
}));

(vi as any).mock('./components/OpenProjectWizard.jsx', () => ({
  default: function MockLegacyWizard() {
    return <div data-testid="legacy-wizard-mock" />;
  },
  NEW_PROJECT_WIZARD_DRAFT_KEY: 'agentHub:v1:newProjectWizardDraft',
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
      getProjects: vi.fn().mockResolvedValue([]),
      getSessions: vi.fn().mockResolvedValue([]),
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

import App from './App';

describe('App — "+ New Project" CTA routes to adaptive flow', () => {
  const origElectron = globalThis.window?.electronAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    delete (globalThis as any).__ahNewProjectCTA;
    delete (globalThis as any).__ahAdaptiveOnClose;
    delete (globalThis as any).__ahAdaptiveOnProjectCreated;
    if (globalThis.window) globalThis.window.electronAPI = undefined;
    (globalThis as any).fetch = vi.fn((url: any) => {
      const u = String(url);
      if (u.includes('/setup/status')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ firstRun: false }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
  });

  afterEach(() => {
    cleanup();
    if (globalThis.window) globalThis.window.electronAPI = origElectron;
  });

  it('mounts NewProjectAdaptiveFlow when the CTA fires, and unmounts on onClose', async () => {
    render(<App />);

    // Wait for Sidebar mock to have received the onOpenProject callback
    await waitFor(
      () => {
        expect(typeof (globalThis as any).__ahNewProjectCTA).toBe('function');
      },
      { timeout: 3000 },
    );

    // Before click: adaptive flow must not be mounted; legacy wizard
    // must also not be mounted.
    expect(screen.queryByTestId('adaptive-flow-mock')).not.toBeInTheDocument();
    expect(screen.queryByTestId('legacy-wizard-mock')).not.toBeInTheDocument();

    // Simulate the sidebar CTA click.
    await act(async () => {
      (globalThis as any).__ahNewProjectCTA();
    });

    // Adaptive flow mounts; legacy wizard stays hidden.
    await waitFor(() => {
      expect(screen.getByTestId('adaptive-flow-mock')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('legacy-wizard-mock')).not.toBeInTheDocument();
    expect(typeof (globalThis as any).__ahAdaptiveOnClose).toBe('function');

    // Fire the flow's onClose — the adaptive mount should come down.
    await act(async () => {
      (globalThis as any).__ahAdaptiveOnClose();
    });

    await waitFor(() => {
      expect(screen.queryByTestId('adaptive-flow-mock')).not.toBeInTheDocument();
    });
  });

  it('routes to chat view when onProjectCreated fires with action:"chat"', async () => {
    render(<App />);

    await waitFor(() => expect(typeof (globalThis as any).__ahNewProjectCTA).toBe('function'), {
      timeout: 3000,
    });

    // Open the adaptive flow
    await act(async () => {
      (globalThis as any).__ahNewProjectCTA();
    });
    await waitFor(() => {
      expect(screen.getByTestId('adaptive-flow-mock')).toBeInTheDocument();
    });

    // Fire onProjectCreated with action:'chat'
    await act(async () => {
      (globalThis as any).__ahAdaptiveOnProjectCreated({
        action: 'chat',
        agentId: 'test-agent-1',
        projectId: 'proj-1',
      });
    });

    // The adaptive flow should unmount (view is now 'chat', not 'new-project-adaptive')
    await waitFor(() => {
      expect(screen.queryByTestId('adaptive-flow-mock')).not.toBeInTheDocument();
    });
    // Sidebar should reflect the chat view
    expect(screen.getByTestId('sidebar-mock').dataset.currentView).toBe('chat');
  });

  it('routes to kanban view when onProjectCreated fires with action:"task"', async () => {
    render(<App />);

    await waitFor(() => expect(typeof (globalThis as any).__ahNewProjectCTA).toBe('function'), {
      timeout: 3000,
    });

    // Open the adaptive flow
    await act(async () => {
      (globalThis as any).__ahNewProjectCTA();
    });
    await waitFor(() => {
      expect(screen.getByTestId('adaptive-flow-mock')).toBeInTheDocument();
    });

    // Fire onProjectCreated with action:'task'
    await act(async () => {
      (globalThis as any).__ahAdaptiveOnProjectCreated({
        action: 'task',
        projectId: 'proj-2',
      });
    });

    // The adaptive flow should unmount (view is now 'kanban:proj-2')
    await waitFor(() => {
      expect(screen.queryByTestId('adaptive-flow-mock')).not.toBeInTheDocument();
    });
    // Sidebar should reflect the kanban view
    expect(screen.getByTestId('sidebar-mock').dataset.currentView).toBe('kanban:proj-2');
  });

  it('routes to import wizard when onProjectCreated fires with action:"import"', async () => {
    render(<App />);

    await waitFor(() => expect(typeof (globalThis as any).__ahNewProjectCTA).toBe('function'), {
      timeout: 3000,
    });

    await act(async () => {
      (globalThis as any).__ahNewProjectCTA();
    });
    await waitFor(() => {
      expect(screen.getByTestId('adaptive-flow-mock')).toBeInTheDocument();
    });

    await act(async () => {
      (globalThis as any).__ahAdaptiveOnProjectCreated({
        action: 'import',
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('adaptive-flow-mock')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('legacy-wizard-mock')).toBeInTheDocument();
  });
});
