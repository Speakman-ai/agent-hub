/**
 * App integration: first-run setup wizard gating.
 *
 * Verifies that the SetupWizard is shown on a truly fresh install — even
 * when the host already has Claude/Cursor/Codex authenticated and the
 * server auto-seeded a `default` org — because the authoritative signal
 * is whether an Agent Hub Owner record exists.
 *
 * Regression test for "first-run wizard skipped when host has
 * Claude/Cursor authed (or default org auto-seeds)" — the previous gate
 * checked `getOrgs()`, which is always truthy after `initOrgsDb()` seeds
 * the default org, so the wizard never fired on a real fresh clone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, cleanup, screen } from '@testing-library/react';

// Default-org cached locally — mirrors what `fetchOrgs()` does on a
// fresh install after `initOrgsDb()` seeds the default row server-side.
(vi as any).mock('./utils/orgs.js', () => ({
  migrateFromLegacy: () => Promise.resolve(),
  fetchOrgs: () => Promise.resolve(),
  getActiveOrg: () => ({ id: 'default', name: 'Default', mode: 'local' }),
  getOrgs: () => ({ orgs: [{ id: 'default', name: 'Default' }], activeOrgId: 'default' }),
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
    return <div data-testid="sidebar-mock" />;
  },
}));

(vi as any).mock('./components/NewProjectAdaptiveFlow.jsx', () => ({
  default: function MockAdaptiveFlow() {
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

// Capture the props handed to the SetupWizard so we can assert which
// step it starts on without having to render the real implementation.
(vi as any).mock('./components/SetupWizard.jsx', async () => {
  const actual = await vi.importActual('./components/SetupWizard.jsx');
  return {
    ...actual,
    default: function MockSetupWizard(p: any) {
      if (typeof globalThis !== 'undefined') {
        (globalThis as any).__ahSetupWizardProps = p;
      }
      return (
        <div
          data-testid="setup-wizard-mock"
          data-initial-step={String(p.initialStep)}
          data-include-first-project={p.includeFirstProject === false ? 'false' : 'true'}
        />
      );
    },
  };
});

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
import { setActiveOrgIsLocal, setToken } from './utils/auth';

function mockFetchWithSetupStatus(status: any) {
  return vi.fn((url: any) => {
    const u = String(url);
    if (u.includes('/setup/status')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(status) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

describe('App — first-run SetupWizard gating', () => {
  const origElectron = globalThis.window?.electronAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setActiveOrgIsLocal(false);
    delete (globalThis as any).__ahSetupWizardProps;
    if (globalThis.window) {
      globalThis.window.electronAPI = undefined;
      // Prior tests may leave `#/new-project-adaptive` via App's hash sync.
      globalThis.window.history.replaceState(null, '', '/');
    }
    document.body.innerHTML = '';
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    if (globalThis.window) globalThis.window.electronAPI = origElectron;
  });

  it('shows the full wizard from step 1 on a fresh clone (Owner not created, default org seeded, host Claude authed)', async () => {
    // This is the regression scenario. Before the fix, the gate keyed on
    // `getOrgs()` which is truthy from the auto-seeded default org, so the
    // wizard was skipped and `NewProjectAdaptiveFlow` mounted instead.
    (globalThis as any).fetch = mockFetchWithSetupStatus({
      firstRun: true,
      authConfigured: false,
      hasAnyAiCredentials: true,
      engineAuth: { 'claude-code': true, 'cursor-agent': false, 'codex-cli': false },
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('setup-wizard-mock')).toBeInTheDocument();
    });
    expect(screen.getByTestId('setup-wizard-mock').dataset.initialStep).toBe('1');
    expect(screen.queryByTestId('adaptive-flow-mock')).not.toBeInTheDocument();
  });

  it('skips the wizard for a returning user with no projects yet (Owner exists, orgs cached)', async () => {
    // Existing behavior: once the Owner is set up AND onboarding is marked
    // complete, "firstRun:true" should open the adaptive project wizard,
    // not the SetupWizard.
    (globalThis as any).fetch = mockFetchWithSetupStatus({
      firstRun: true,
      authConfigured: true,
      onboardingComplete: true,
      hasAnyAiCredentials: true,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('adaptive-flow-mock')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('setup-wizard-mock')).not.toBeInTheDocument();
  });

  it('resumes the SetupWizard when Owner exists but onboarding was interrupted', async () => {
    // Bitwarden / reload after /api/auth/setup: auth.json exists but the
    // wizard never reached "Open Project". Must not dump into main chrome.
    (globalThis as any).fetch = mockFetchWithSetupStatus({
      firstRun: true,
      authConfigured: true,
      onboardingComplete: false,
      hasAnyAiCredentials: true,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('setup-wizard-mock')).toBeInTheDocument();
    });
    // Owner already exists → land on Welcome (step 1 of the no-account plan).
    expect(screen.getByTestId('setup-wizard-mock').dataset.initialStep).toBe('1');
    // Adaptive project flow must not replace the interrupted SetupWizard.
    await waitFor(() => {
      expect(screen.queryByTestId('adaptive-flow-mock')).not.toBeInTheDocument();
    });
  });

  it('shows the wizard at the AI-credentials step when Owner exists but engines are wiped', async () => {
    // Sandbox-reset path: Owner record + default org survive but
    // claude/cursor/codex CLIs are no longer authed. We want to land at
    // the credentials step (step 2), not step 1.
    (globalThis as any).fetch = mockFetchWithSetupStatus({
      firstRun: false,
      authConfigured: true,
      onboardingComplete: true,
      hasAnyAiCredentials: false,
      engineAuth: { 'claude-code': false, 'cursor-agent': false, 'codex-cli': false },
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('setup-wizard-mock')).toBeInTheDocument();
    });
    expect(screen.getByTestId('setup-wizard-mock').dataset.initialStep).toBe('2');
  });

  it('still routes to the wizard when the server omits authConfigured (legacy server, no orgs)', async () => {
    // Older servers that don't return `authConfigured` should still hit
    // the legacy fallback. With no AI credentials we always show the
    // wizard regardless of the new field.
    (globalThis as any).fetch = mockFetchWithSetupStatus({
      firstRun: true,
      hasAnyAiCredentials: false,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('setup-wizard-mock')).toBeInTheDocument();
    });
  });

  function seedRole(role: 'Owner' | 'Admin' | 'User') {
    setToken({
      token: 'test-jwt',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      user: { username: 'member@example.com', role },
    });
  }

  it('does not trap an invited User in instance onboarding when the Owner has not finished setup', async () => {
    seedRole('User');
    (globalThis as any).fetch = mockFetchWithSetupStatus({
      firstRun: false,
      authConfigured: true,
      onboardingComplete: false,
      hasAnyAiCredentials: true,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('sidebar-mock')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('setup-wizard-mock')).not.toBeInTheDocument();
  });

  it('shows a credentials walkthrough without First Project for a User with no AI engines', async () => {
    seedRole('User');
    (globalThis as any).fetch = mockFetchWithSetupStatus({
      firstRun: false,
      authConfigured: true,
      onboardingComplete: true,
      hasAnyAiCredentials: false,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('setup-wizard-mock')).toBeInTheDocument();
    });
    expect(screen.getByTestId('setup-wizard-mock').dataset.includeFirstProject).toBe('false');
    expect(screen.getByTestId('setup-wizard-mock').dataset.initialStep).toBe('2');
  });
});
