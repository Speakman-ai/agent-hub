import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';

/**
 * Regression: the Hub assistant composer must bind and send ONLY to the live
 * per-user Hub session (from GET /api/me/hub). Before that GET resolves, the
 * default init flow sets activeAgentId to a project agent (flat[0]) and would
 * restore that agent's last session — the assistant pane must NOT let the user
 * type/send into that project session, and the hidden Hub agent id must never
 * be persisted as localStorage.activeAgentId.
 */

const ctl: any = { resolveProjects: null, resolveSessionsByAgent: {}, resolveHub: null };

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
  default: () => <div data-testid="sidebar-mock" />,
}));
(vi as any).mock('./components/SessionSummarySidebar.jsx', () => ({
  default: () => <div data-testid="session-summary-mock" />,
}));
const wsSend = vi.fn();
(vi as any).mock('./hooks/useWebSocket.js', () => ({
  useWebSocket: () => ({
    send: wsSend,
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
      ensureSessionWorkspace: vi.fn().mockResolvedValue({ ok: true, skipped: true }),
      getMeDashboard: vi.fn().mockResolvedValue({}),
      // Controllable Hub session GET.
      getHubSession: vi.fn(
        () =>
          new Promise((resolve: any) => {
            ctl.resolveHub = resolve;
          }),
      ),
      clearHubSession: vi.fn(() =>
        Promise.resolve({
          session: { id: 'hub-sess-2', engine: 'claude-code', model: 'claude-opus-4-8' },
        }),
      ),
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
    agents: [{ id: 'agent-1', name: 'Frontend', color: '#3b82f6', engine: 'claude-code' }],
  },
];
const PROJECT_SESSION = [{ id: 'proj-sess-1', name: 'P1', engine: 'claude-code' }];

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

describe('App — Hub assistant composer binds only to the live Hub session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ctl.resolveProjects = null;
    ctl.resolveSessionsByAgent = {};
    ctl.resolveHub = null;
    localStorage.clear();
    (globalThis as any).window.electronAPI = undefined;
    mockFetch();
    wsSend.mockClear();
  });

  it('locks the composer until the Hub GET resolves, then enables it, and never persists the Hub agent id', async () => {
    render(<App initialView="hub" />);

    await waitFor(() => expect(typeof ctl.resolveProjects).toBe('function'), { timeout: 3000 });
    await act(async () => {
      ctl.resolveProjects(PROJECT_FIXTURE);
    });
    // The project agent's session load resolves — but the Hub is focused, so it
    // must NOT retarget the assistant composer to a project session.
    await waitFor(() => expect(typeof ctl.resolveSessionsByAgent['agent-1']).toBe('function'), {
      timeout: 3000,
    });
    await act(async () => {
      ctl.resolveSessionsByAgent['agent-1'](PROJECT_SESSION);
    });

    // Composer is present but disabled while the Hub session is unresolved.
    const textarea = await screen.findByRole('textbox');
    expect((textarea as HTMLTextAreaElement).disabled).toBe(true);

    // Resolve the Hub session — the composer unlocks and binds to it.
    await act(async () => {
      ctl.resolveHub({
        agent: { id: '__hub_assistant__', name: 'Hub', engine: 'claude-code' },
        session: { id: 'hub-sess-1', engine: 'claude-code', model: 'claude-opus-4-8' },
      });
    });

    await waitFor(() =>
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false),
    );

    // The hidden Hub agent id is never persisted as the restored agent.
    expect(localStorage.getItem('activeAgentId')).not.toBe('__hub_assistant__');
  });

  it('dispatches the Hub turn as __hub_assistant__ even when init lands AFTER the Hub GET', async () => {
    render(<App initialView="hub" />);

    // Resolve the Hub GET FIRST — hubSessionId + active session become the Hub's.
    await waitFor(() => expect(typeof ctl.resolveHub).toBe('function'), { timeout: 3000 });
    await act(async () => {
      ctl.resolveHub({
        agent: { id: '__hub_assistant__', name: 'Hub', engine: 'claude-code' },
        session: { id: 'hub-sess-1', engine: 'claude-code', model: 'claude-opus-4-8' },
      });
    });

    // THEN init settles projects and stamps activeAgentId to the project agent.
    await waitFor(() => expect(typeof ctl.resolveProjects).toBe('function'), { timeout: 3000 });
    await act(async () => {
      ctl.resolveProjects(PROJECT_FIXTURE);
    });
    await waitFor(() => expect(typeof ctl.resolveSessionsByAgent['agent-1']).toBe('function'), {
      timeout: 3000,
    });
    await act(async () => {
      ctl.resolveSessionsByAgent['agent-1'](PROJECT_SESSION);
    });

    // Composer is enabled (Hub session is active) even though activeAgentId is a
    // project agent — the send must still run as the Hub agent.
    const textarea = await screen.findByRole('textbox');
    await waitFor(() => expect((textarea as HTMLTextAreaElement).disabled).toBe(false));

    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'what should I focus on' } });
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
    });

    await waitFor(() => expect(wsSend).toHaveBeenCalled());
    const chat = wsSend.mock.calls.map((c) => c[0]).find((m: any) => m?.type === 'chat');
    expect(chat).toBeTruthy();
    // The Hub turn runs as the Hub agent + Hub session, NOT the project agent.
    expect(chat.agentId).toBe('__hub_assistant__');
    expect(chat.sessionId).toBe('hub-sess-1');
  });

  it('keeps the composer usable after Clear (advances the canonical Hub session id)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      render(<App initialView="hub" />);

      await waitFor(() => expect(typeof ctl.resolveProjects).toBe('function'), { timeout: 3000 });
      await act(async () => {
        ctl.resolveProjects(PROJECT_FIXTURE);
      });
      await waitFor(() => expect(typeof ctl.resolveSessionsByAgent['agent-1']).toBe('function'), {
        timeout: 3000,
      });
      await act(async () => {
        ctl.resolveSessionsByAgent['agent-1'](PROJECT_SESSION);
      });
      await act(async () => {
        ctl.resolveHub({
          agent: { id: '__hub_assistant__', name: 'Hub', engine: 'claude-code' },
          session: { id: 'hub-sess-1', engine: 'claude-code', model: 'claude-opus-4-8' },
        });
      });

      const textarea = await screen.findByRole('textbox');
      await waitFor(() => expect((textarea as HTMLTextAreaElement).disabled).toBe(false));

      // Clear the Hub chat — it mints hub-sess-2. The composer must NOT lock up.
      // (The clear button renders in both the toolbar and the assistant header.)
      const clearBtn = screen.getAllByTestId('hub-clear-chat')[0];
      await act(async () => {
        fireEvent.click(clearBtn);
      });

      await waitFor(() =>
        expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false),
      );

      // A send after Clear targets the FRESH Hub session.
      await act(async () => {
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello again' } });
        fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', code: 'Enter' });
      });
      await waitFor(() => expect(wsSend).toHaveBeenCalled());
      const chat = wsSend.mock.calls.map((c) => c[0]).find((m: any) => m?.type === 'chat');
      expect(chat.agentId).toBe('__hub_assistant__');
      expect(chat.sessionId).toBe('hub-sess-2');
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('keeps the composer usable on a LEGACY Hub entry point (currentView=dashboard)', async () => {
    // The Hub is also reached via legacy views (home/dashboard/todos/calendar/
    // gmail) that stay as currentView='dashboard' etc. The late-restore guard
    // must fire on those too, or a project-session restore locks the assistant.
    render(<App initialView="dashboard" />);

    // Hub GET resolves first — Hub session becomes active.
    await waitFor(() => expect(typeof ctl.resolveHub).toBe('function'), { timeout: 3000 });
    await act(async () => {
      ctl.resolveHub({
        agent: { id: '__hub_assistant__', name: 'Hub', engine: 'claude-code' },
        session: { id: 'hub-sess-1', engine: 'claude-code', model: 'claude-opus-4-8' },
      });
    });

    // Then init + a late project-session restore land while on the legacy view.
    await waitFor(() => expect(typeof ctl.resolveProjects).toBe('function'), { timeout: 3000 });
    await act(async () => {
      ctl.resolveProjects(PROJECT_FIXTURE);
    });
    await waitFor(() => expect(typeof ctl.resolveSessionsByAgent['agent-1']).toBe('function'), {
      timeout: 3000,
    });
    await act(async () => {
      ctl.resolveSessionsByAgent['agent-1'](PROJECT_SESSION);
    });

    // The project restore must NOT stomp the Hub session — composer stays usable
    // without the user having to click a pane to flip currentView to 'hub'.
    const textarea = await screen.findByRole('textbox');
    await waitFor(() => expect((textarea as HTMLTextAreaElement).disabled).toBe(false));
  });
});
