import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, cleanup, screen, fireEvent } from '@testing-library/react';

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
    (globalThis as any).__ahSidebarProps = p;
    return <div data-testid="sidebar-mock" data-current-view={p.currentView || ''} />;
  },
}));

(vi as any).mock('./components/NewProjectAdaptiveFlow.jsx', () => ({
  default: function MockAdaptiveFlow() {
    return <div data-testid="adaptive-flow-mock" />;
  },
}));

(vi as any).mock('./components/OpenProjectWizard.jsx', () => ({
  default: function MockLegacyWizard() {
    return <div data-testid="legacy-wizard-mock" />;
  },
  NEW_PROJECT_WIZARD_DRAFT_KEY: 'agentHub:v1:newProjectWizardDraft',
}));

(vi as any).mock('./components/KanbanBoard.jsx', () => ({
  default: function MockKanbanBoard(p: any) {
    (globalThis as any).__ahKanbanBoardProps = p;
    return (
      <div
        data-testid="kanban-board-mock"
        data-project-id={p.projectId || ''}
        data-pending-template-id={p.pendingCreateTemplate?.id || ''}
      />
    );
  },
}));

(vi as any).mock('./components/KanbanCardTemplatesView.jsx', () => ({
  default: function MockKanbanCardTemplatesView(p: any) {
    (globalThis as any).__ahKanbanTemplatesProps = p;
    return (
      <button
        type="button"
        data-testid="template-use"
        onClick={() =>
          p.onUseTemplate({
            id: 'template-1',
            name: 'Bug template',
            title: 'Fix routed bug',
            description: '',
            priority: 'high',
            labels: 'bug',
            epicId: '',
            updatedAt: '2026-01-01T00:00:00.000Z',
          })
        }
      >
        Use template
      </button>
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
  const empty = { engineDefaultModels: { 'claude-code': 'claude-opus-4-8' } };
  return {
    ...mod,
    api: {
      ...mod.api,
      getModelConfig: vi.fn().mockResolvedValue(empty),
      getProjects: vi.fn().mockResolvedValue([{ id: 'p1', name: 'Project 1' }]),
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

describe('App kanban template routing', () => {
  const origElectron = globalThis.window?.electronAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', '/');
    localStorage.clear();
    delete (globalThis as any).__ahSidebarProps;
    delete (globalThis as any).__ahKanbanBoardProps;
    delete (globalThis as any).__ahKanbanTemplatesProps;
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
    delete (globalThis as any).__ahSidebarProps;
    delete (globalThis as any).__ahKanbanBoardProps;
    delete (globalThis as any).__ahKanbanTemplatesProps;
    if (globalThis.window) globalThis.window.electronAPI = origElectron;
  });

  it('carries a used template into the remounted board instead of relying on action refs', async () => {
    render(<App initialView="kanban:p1" />);

    await waitFor(() => expect(screen.getByTestId('kanban-board-mock')).toBeInTheDocument());

    await act(async () => {
      (globalThis as any).__ahKanbanBoardProps.onOpenTemplates();
    });

    await waitFor(() => expect(screen.getByTestId('template-use')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('template-use'));

    await waitFor(() =>
      expect(screen.getByTestId('kanban-board-mock')).toHaveAttribute(
        'data-pending-template-id',
        'template-1',
      ),
    );

    expect((globalThis as any).__ahKanbanBoardProps.onCardActionsReady).toBeUndefined();
    expect((globalThis as any).__ahKanbanBoardProps.pendingCreateTemplate).toMatchObject({
      id: 'template-1',
      title: 'Fix routed bug',
    });
  });

  it('resets kanban filters and facets when switching kanban projects', async () => {
    render(<App initialView="kanban:p1" />);

    await waitFor(() => expect(screen.getByTestId('kanban-board-mock')).toBeInTheDocument());

    await act(async () => {
      (globalThis as any).__ahKanbanBoardProps.onSelectedEpicIdsChange(new Set(['epic-p1']));
      (globalThis as any).__ahKanbanBoardProps.onAvailableLabelsChange(['p1-label']);
      (globalThis as any).__ahKanbanBoardProps.onAssignableUsersChange([
        { id: 'user-p1', username: 'lead-p1' },
      ]);
      (globalThis as any).__ahSidebarProps.onKanbanSelectedLabelsChange(new Set(['p1-label']));
      (globalThis as any).__ahSidebarProps.onKanbanSelectedUserIdsChange(new Set(['user-p1']));
    });

    await waitFor(() =>
      expect((globalThis as any).__ahKanbanBoardProps.selectedEpicIds.has('epic-p1')).toBe(true),
    );
    expect((globalThis as any).__ahKanbanBoardProps.selectedLabels.has('p1-label')).toBe(true);
    expect((globalThis as any).__ahKanbanBoardProps.selectedUserIds.has('user-p1')).toBe(true);
    expect((globalThis as any).__ahSidebarProps.kanbanAvailableLabels).toEqual(['p1-label']);
    expect((globalThis as any).__ahKanbanBoardProps.assignableUsers).toEqual([
      { id: 'user-p1', username: 'lead-p1' },
    ]);

    await act(async () => {
      (globalThis as any).__ahSidebarProps.onNavigate('kanban:p2');
    });

    await waitFor(() => expect((globalThis as any).__ahKanbanBoardProps.projectId).toBe('p2'));
    await waitFor(() =>
      expect((globalThis as any).__ahKanbanBoardProps.selectedEpicIds.size).toBe(0),
    );
    expect((globalThis as any).__ahKanbanBoardProps.selectedLabels.size).toBe(0);
    expect((globalThis as any).__ahKanbanBoardProps.selectedUserIds.size).toBe(0);
    expect((globalThis as any).__ahSidebarProps.kanbanAvailableLabels).toEqual([]);
    expect((globalThis as any).__ahKanbanBoardProps.assignableUsers).toEqual([]);
  });
});
