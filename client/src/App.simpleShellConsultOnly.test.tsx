import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';

/**
 * The simple shell only shows consult chats. A restored or loader-picked
 * build session must open in the full Hub, where its build controls are
 * visible, instead of sitting in the consult-only chat with them hidden.
 */

const ctl: any = { resolveProjects: null, resolveSessionsByAgent: {}, openRef: null, roster: null };

// Capture the chip-open handler the Server Agent transcript hands its chips.
(vi as any).mock('./components/HubChatRefs', async (importOriginal: any) => {
  const actual = await importOriginal();
  const Real = actual.HubChatRefOpenContext;
  return {
    ...actual,
    HubChatRefOpenContext: {
      ...Real,
      Provider: ({ value, children }: any) => {
        ctl.openRef = value;
        return <Real.Provider value={value}>{children}</Real.Provider>;
      },
    },
  };
});

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
  default: (props: any) => {
    ctl.sidebar = props;
    return <div data-testid="sidebar-mock" />;
  },
}));
(vi as any).mock('./components/SimpleRoster.jsx', () => ({
  default: (props: any) => {
    ctl.roster = props;
    return <div data-testid="simple-roster-mock" />;
  },
}));
(vi as any).mock('./components/SessionSummarySidebar.jsx', () => ({
  default: () => <div data-testid="session-summary-mock" />,
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
      createSession: vi.fn(
        () =>
          new Promise((resolve: any) => {
            ctl.resolveCreates.push(resolve);
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
      getHubSession: vi.fn(
        () =>
          new Promise((resolve: any) => {
            ctl.resolveHub = resolve;
          }),
      ),
    },
  };
});

import App from './App';
import { api } from './utils/api';

const PROJECTS = [
  {
    id: 'proj-1',
    name: 'Project',
    color: '#3b82f6',
    cwd: '/tmp/w',
    ahw: '/tmp/w',
    agents: [
      { id: 'agent-1', name: 'Frontend', color: '#3b82f6', engine: 'claude-code' },
      { id: 'agent-2', name: 'Backend', color: '#22c55e', engine: 'claude-code' },
    ],
  },
];
const BUILD = {
  id: 'build-1',
  agent_id: 'agent-1',
  name: 'Build',
  engine: 'claude-code',
  session_mode: null,
  updated_at: '2026-11-02T10:00:00Z',
};
const CONSULT = {
  id: 'consult-1',
  agent_id: 'agent-1',
  name: 'Chat',
  engine: 'claude-code',
  session_mode: 'consult',
  updated_at: '2026-11-01T10:00:00Z',
};

function shellMode(container: HTMLElement) {
  return container.querySelector('[data-shell-mode]')?.getAttribute('data-shell-mode');
}

async function mountSimpleChat(restoredSessionId: string) {
  localStorage.setItem('activeAgentId', 'agent-1');
  localStorage.setItem('activeSessionId:agent-1', restoredSessionId);
  window.location.hash = '#/chat?shell=simple';
  const view = render(<App />);
  await waitFor(() => expect(typeof ctl.resolveProjects).toBe('function'), { timeout: 3000 });
  expect(shellMode(view.container)).toBe('simple');
  await act(async () => {
    ctl.resolveProjects(PROJECTS);
  });
  await waitFor(() => expect(typeof ctl.resolveSessionsByAgent['agent-1']).toBe('function'), {
    timeout: 3000,
  });
  await act(async () => {
    ctl.resolveSessionsByAgent['agent-1']([BUILD, CONSULT]);
  });
  return view;
}

describe('App — simple shell stays consult-only', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ctl.resolveProjects = null;
    ctl.resolveSessionsByAgent = {};
    ctl.openRef = null;
    ctl.roster = null;
    ctl.resolveCreates = [];
    ctl.sidebar = null;
    ctl.resolveHub = null;
    localStorage.clear();
    (globalThis as any).window.electronAPI = undefined;
    (globalThis as any).fetch = vi.fn((url: any) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(String(url).includes('/setup/status') ? { firstRun: false } : {}),
      }),
    );
  });

  it('opens a restored build session in the full Hub instead of the simple chat', async () => {
    const { container } = await mountSimpleChat(BUILD.id);
    await waitFor(() => expect(shellMode(container)).toBe('hub'));
    expect(localStorage.getItem('agenthub.shellMode')).toBe('hub');
  });

  it('keeps the simple shell for a restored consult chat', async () => {
    const { container } = await mountSimpleChat(CONSULT.id);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(shellMode(container)).toBe('simple');
  });

  it('opens a dispatched build chip from the Simple Server Agent chat in the full Hub', async () => {
    localStorage.setItem('activeAgentId', 'agent-1');
    window.location.hash = '#/hub/agent?shell=simple';
    const { container } = render(<App />);
    await waitFor(() => expect(typeof ctl.resolveProjects).toBe('function'), { timeout: 3000 });
    await act(async () => {
      ctl.resolveProjects(PROJECTS);
    });
    await waitFor(() => expect(typeof ctl.openRef).toBe('function'), { timeout: 3000 });
    expect(shellMode(container)).toBe('simple');
    await act(async () => {
      ctl.openRef({
        kind: 'session',
        visible: true,
        agentId: 'agent-1',
        targetId: BUILD.id,
        label: 'Build',
      });
    });
    await waitFor(() => expect(shellMode(container)).toBe('hub'));
  });

  it('stays on the current view until the roster has resolved the consult chat', async () => {
    const { container } = await mountSimpleChat(CONSULT.id);
    await waitFor(() => expect(typeof ctl.roster?.onOpenAgent).toBe('function'));
    await act(async () => {
      ctl.roster.onOpenServerAgent();
    });
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/hub/));
    const serverView = window.location.hash;

    await act(async () => {
      ctl.roster.onOpenAgent('agent-2');
    });
    await waitFor(() => expect(typeof ctl.resolveSessionsByAgent['agent-2']).toBe('function'));
    // The list is still loading: no chat view bound to the previous session.
    expect(window.location.hash).toBe(serverView);

    await act(async () => {
      ctl.resolveSessionsByAgent['agent-2']([
        { id: 'b-chat', agent_id: 'agent-2', session_mode: 'consult', engine: 'claude-code' },
      ]);
    });
    await waitFor(() => expect(window.location.hash).not.toBe(serverView));
    expect(shellMode(container)).toBe('simple');
  });

  async function openServerAgentView() {
    await waitFor(() => expect(typeof ctl.roster?.onOpenAgent).toBe('function'));
    await act(async () => {
      ctl.roster.onOpenServerAgent();
    });
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/hub/));
  }

  const AGENT_2_CHAT = {
    id: 'b-chat',
    agent_id: 'agent-2',
    session_mode: 'consult',
    engine: 'claude-code',
  };

  it('ignores a slow roster open once a later chat was chosen', async () => {
    await mountSimpleChat(CONSULT.id);
    await openServerAgentView();
    await act(async () => {
      ctl.roster.onOpenAgent('agent-2');
    });
    await waitFor(() => expect(typeof ctl.resolveSessionsByAgent['agent-2']).toBe('function'));
    // A cached chat opens immediately while agent-2's list is still loading.
    await act(async () => {
      ctl.roster.onOpenAgent('agent-1');
    });
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/chat/));

    await act(async () => {
      ctl.resolveSessionsByAgent['agent-2']([AGENT_2_CHAT]);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(localStorage.getItem('activeAgentId')).toBe('agent-1');
    expect(localStorage.getItem('activeSessionId:agent-1')).toBe(CONSULT.id);
  });

  it('ignores a slow roster open after Full Hub was chosen', async () => {
    const { container } = await mountSimpleChat(CONSULT.id);
    await openServerAgentView();
    await act(async () => {
      ctl.roster.onOpenAgent('agent-2');
    });
    await waitFor(() => expect(typeof ctl.resolveSessionsByAgent['agent-2']).toBe('function'));
    await act(async () => {
      ctl.roster.onOpenFullHub();
    });
    await waitFor(() => expect(shellMode(container)).toBe('hub'));

    await act(async () => {
      ctl.resolveSessionsByAgent['agent-2']([AGENT_2_CHAT]);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(shellMode(container)).toBe('hub');
    expect(localStorage.getItem('activeAgentId')).toBe('agent-1');
  });

  it('returns Full Hub to the build that was open when Simple was entered', async () => {
    localStorage.setItem('activeAgentId', 'agent-1');
    localStorage.setItem('activeSessionId:agent-1', BUILD.id);
    window.location.hash = '#/chat';
    const { container } = render(<App />);
    await waitFor(() => expect(typeof ctl.resolveProjects).toBe('function'), { timeout: 3000 });
    await act(async () => {
      ctl.resolveProjects(PROJECTS);
    });
    await waitFor(() => expect(typeof ctl.resolveSessionsByAgent['agent-1']).toBe('function'));
    await act(async () => {
      ctl.resolveSessionsByAgent['agent-1']([BUILD, CONSULT]);
    });
    await waitFor(() => expect(typeof ctl.sidebar?.onOpenSimpleView).toBe('function'));
    expect(shellMode(container)).toBe('hub');

    // Enter Simple on the Server Agent, which takes over the active session.
    await act(async () => {
      ctl.sidebar.onOpenSimpleView();
    });
    await waitFor(() => expect(typeof ctl.resolveHub).toBe('function'));
    await act(async () => {
      ctl.resolveHub({
        agent: { id: '__hub_assistant__', name: 'Hub', engine: 'claude-code' },
        session: { id: 'hub-sess-1', engine: 'claude-code', model: 'claude-opus-4-8' },
      });
    });
    expect(shellMode(container)).toBe('simple');

    // A roster chat inside Simple keeps the original target.
    await act(async () => {
      ctl.roster.onOpenAgent('agent-1');
    });
    await waitFor(() => expect(localStorage.getItem('activeSessionId:agent-1')).toBe(CONSULT.id));

    await act(async () => {
      ctl.roster.onOpenFullHub();
    });
    await waitFor(() => expect(shellMode(container)).toBe('hub'));
    await waitFor(() => expect(localStorage.getItem('activeSessionId:agent-1')).toBe(BUILD.id));
    expect(localStorage.getItem('activeAgentId')).toBe('agent-1');
  });

  it('makes one consult chat for repeated clicks and persists it only for the current open', async () => {
    await mountSimpleChat(CONSULT.id);
    await openServerAgentView();
    await act(async () => {
      ctl.roster.onOpenAgent('agent-2');
    });
    await waitFor(() => expect(typeof ctl.resolveSessionsByAgent['agent-2']).toBe('function'));
    await act(async () => {
      ctl.resolveSessionsByAgent['agent-2']([]);
    });
    await act(async () => {
      ctl.roster.onOpenAgent('agent-2');
    });
    await waitFor(() => expect(ctl.resolveCreates.length).toBe(1));
    expect(api.createSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      ctl.resolveCreates[0]({ ...AGENT_2_CHAT, id: 'b-new' });
    });
    await waitFor(() => expect(localStorage.getItem('activeSessionId:agent-2')).toBe('b-new'));
    expect(localStorage.getItem('agenthub.simpleSession:agent-2')).toBe('b-new');
  });

  it('does not remember a consult chat created for an open that was superseded', async () => {
    await mountSimpleChat(CONSULT.id);
    await openServerAgentView();
    await act(async () => {
      ctl.roster.onOpenAgent('agent-2');
    });
    await waitFor(() => expect(typeof ctl.resolveSessionsByAgent['agent-2']).toBe('function'));
    await act(async () => {
      ctl.resolveSessionsByAgent['agent-2']([]);
    });
    await waitFor(() => expect(ctl.resolveCreates.length).toBe(1));
    await act(async () => {
      ctl.roster.onOpenAgent('agent-1');
    });
    await act(async () => {
      ctl.resolveCreates[0]({ ...AGENT_2_CHAT, id: 'b-late' });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(localStorage.getItem('agenthub.simpleSession:agent-2')).toBeNull();
    expect(localStorage.getItem('activeAgentId')).toBe('agent-1');
  });
});
