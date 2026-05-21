/**
 * App: switching `activeSessionId` clears messages immediately and shows
 * `data-testid="chat-messages-loading"` until `getMessages` resolves (or
 * fails). Guards against stale responses when the user switches again before
 * the prior fetch completes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, cleanup, screen } from '@testing-library/react';

const ctl = vi.hoisted(() => ({
  resolveProjects: null,
  /** @type {Record<string, (value: unknown) => void>} */
  resolveSessionsByAgent: {},
  /** sessionId -> { promise, resolve, reject } */
  messageDefers: new Map(),
  deferredFor(sid) {
    if (!ctl.messageDefers.has(sid)) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      ctl.messageDefers.set(sid, { promise, resolve, reject });
    }
    return ctl.messageDefers.get(sid);
  },
  resetMessages() {
    ctl.messageDefers = new Map();
  },
}));

vi.mock('./utils/orgs.js', () => ({
  migrateFromLegacy: () => Promise.resolve(),
  fetchOrgs: () => Promise.resolve(),
  getActiveOrg: () => null,
  getOrgs: () => ({ orgs: [] }),
  getActiveOrgApiId: () => 'default',
  switchOrg: () => Promise.resolve(),
  reloadForOrgSwitch: () => {},
}));

vi.mock('./utils/connection.js', () => ({
  getApiBase: () => 'http://localhost:3051',
  getAuthHeaders: () => ({}),
  getServerBase: () => 'http://localhost:3051',
}));

vi.mock('./components/Sidebar.jsx', () => ({
  default: function MockSidebar(p) {
    if (typeof globalThis !== 'undefined') {
      if (p.onSelectAgent) globalThis.__ahTestSelectAgent = p.onSelectAgent;
      if (p.onSelectSession) globalThis.__ahTestSelectSession = p.onSelectSession;
    }
    return (
      <div
        data-testid="sidebar-session-msgs"
        data-is-loading={p.isLoading ? 'true' : 'false'}
        aria-label="mock sidebar"
      />
    );
  },
}));

vi.mock('./components/SessionSummarySidebar.jsx', () => ({
  default: function MockSessionSummary() {
    return <div data-testid="session-summary-mock" />;
  },
}));

vi.mock('./hooks/useWebSocket.js', () => ({
  useWebSocket: () => ({
    send: vi.fn(),
    connected: true,
    reconnecting: false,
    wsRef: { current: null },
  }),
}));
vi.mock('./hooks/useDesktopNotifications.js', () => ({
  useDesktopNotifications: () => ({ notify: vi.fn() }),
}));
vi.mock('./hooks/useKeyboardShortcuts.js', () => ({
  useKeyboardShortcuts: () => {},
}));
vi.mock('./hooks/useVersionCheck.js', () => ({
  useVersionCheck: () => ({
    updateAvailable: false,
    serverVersion: null,
    clientVersion: '0',
    downloadUrl: '',
    dismiss: vi.fn(),
  }),
}));

vi.mock('./utils/api.js', async (importOriginal) => {
  const mod = await importOriginal();
  const empty = { engineDefaultModels: { 'claude-code': 'claude-opus-4-7' } };
  return {
    ...mod,
    api: {
      ...mod.api,
      getModelConfig: vi.fn().mockResolvedValue(empty),
      getProjects: vi.fn(
        () =>
          new Promise((resolve) => {
            ctl.resolveProjects = resolve;
          }),
      ),
      getSessions: vi.fn(
        (agentId) =>
          new Promise((resolve) => {
            ctl.resolveSessionsByAgent[agentId] = resolve;
          }),
      ),
      getArchivedSessions: vi.fn().mockResolvedValue([]),
      getSkills: vi.fn().mockResolvedValue([]),
      getRooms: vi.fn().mockResolvedValue([]),
      getDesigns: vi.fn().mockResolvedValue([]),
      getCronSessions: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn((sid) => {
        if (sid === 's-a') {
          return Promise.resolve([{ id: 'm-a', role: 'user', content: 'from-a', created_at: '' }]);
        }
        return ctl.deferredFor(sid).promise;
      }),
      getSessionHandoffs: vi.fn().mockResolvedValue([]),
      getSessionProgress: vi.fn().mockResolvedValue({ steps: [] }),
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

const TWO_SESSIONS = [
  { id: 's-a', name: 'SA', engine: 'claude-code' },
  { id: 's-b', name: 'SB', engine: 'claude-code' },
];

const THREE_SESSIONS = [
  { id: 's-a', name: 'SA', engine: 'claude-code' },
  { id: 's-b', name: 'SB', engine: 'claude-code' },
  { id: 's-c', name: 'SC', engine: 'claude-code' },
];

import App from './App.jsx';
import { api } from './utils/api.js';

function mockFetch() {
  globalThis.fetch = vi.fn((url) => {
    const u = String(url);
    if (u.includes('/setup/status')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ firstRun: false }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
}

async function bootstrapTwoSessions() {
  await waitFor(() => expect(typeof ctl.resolveProjects).toBe('function'), { timeout: 3000 });
  await act(async () => {
    ctl.resolveProjects(PROJECT_FIXTURE);
  });
  await waitFor(() => expect(typeof ctl.resolveSessionsByAgent['agent-1']).toBe('function'), {
    timeout: 3000,
  });
}

describe('App — session switch + getMessages loading', () => {
  const origElectron = globalThis.window.electronAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    ctl.resetMessages();
    ctl.resolveProjects = null;
    ctl.resolveSessionsByAgent = {};
    // Clear everything — previous tests now write per-agent `activeSessionId`
    // keys that would otherwise cause the next test's auto-select to restore
    // the wrong session instead of defaulting to `data[0]`.
    localStorage.clear();
    globalThis.window.electronAPI = undefined;
    mockFetch();
    delete globalThis.__ahTestSelectAgent;
    delete globalThis.__ahTestSelectSession;
  });

  afterEach(() => {
    cleanup();
    globalThis.window.electronAPI = origElectron;
  });

  it('shows chat-messages-loading until deferred getMessages resolves after switching session', async () => {
    render(<App />);
    await bootstrapTwoSessions();

    await act(async () => {
      ctl.resolveSessionsByAgent['agent-1'](TWO_SESSIONS);
    });

    await waitFor(() => {
      expect(api.getMessages).toHaveBeenCalledWith('s-a');
    });
    expect(await screen.findByText('from-a')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-messages-loading')).not.toBeInTheDocument();

    expect(typeof globalThis.__ahTestSelectSession).toBe('function');
    await act(async () => {
      globalThis.__ahTestSelectSession('s-b');
    });

    expect(api.getMessages).toHaveBeenCalledWith('s-b');
    expect(screen.getByTestId('chat-messages-loading')).toBeInTheDocument();
    expect(screen.queryByText('from-a')).not.toBeInTheDocument();

    await act(async () => {
      ctl
        .deferredFor('s-b')
        .resolve([{ id: 'm-b', role: 'user', content: 'from-b', created_at: '' }]);
    });

    await waitFor(() => {
      expect(screen.queryByTestId('chat-messages-loading')).not.toBeInTheDocument();
    });
    expect(await screen.findByText('from-b')).toBeInTheDocument();
  });

  it('does not apply a stale getMessages result after switching away (cancelled effect)', async () => {
    render(<App />);
    await bootstrapTwoSessions();

    await act(async () => {
      ctl.resolveSessionsByAgent['agent-1'](THREE_SESSIONS);
    });

    await waitFor(() => expect(api.getMessages).toHaveBeenCalledWith('s-a'));
    expect(await screen.findByText('from-a')).toBeInTheDocument();

    await act(async () => {
      globalThis.__ahTestSelectSession('s-b');
    });
    expect(screen.getByTestId('chat-messages-loading')).toBeInTheDocument();

    await act(async () => {
      globalThis.__ahTestSelectSession('s-c');
    });
    expect(screen.getByTestId('chat-messages-loading')).toBeInTheDocument();

    await act(async () => {
      ctl
        .deferredFor('s-b')
        .resolve([{ id: 'stale', role: 'user', content: 'stale-b', created_at: '' }]);
    });
    expect(screen.queryByText('stale-b')).not.toBeInTheDocument();

    await act(async () => {
      ctl
        .deferredFor('s-c')
        .resolve([{ id: 'm-c', role: 'user', content: 'from-c', created_at: '' }]);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('chat-messages-loading')).not.toBeInTheDocument();
    });
    expect(await screen.findByText('from-c')).toBeInTheDocument();
  });

  it('clears sessionMessagesLoading when getMessages rejects', async () => {
    render(<App />);
    await bootstrapTwoSessions();

    await act(async () => {
      ctl.resolveSessionsByAgent['agent-1'](TWO_SESSIONS);
    });

    await waitFor(() => expect(api.getMessages).toHaveBeenCalledWith('s-a'));

    await act(async () => {
      globalThis.__ahTestSelectSession('s-b');
    });
    expect(screen.getByTestId('chat-messages-loading')).toBeInTheDocument();

    await act(async () => {
      ctl.deferredFor('s-b').reject(new Error('network'));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('chat-messages-loading')).not.toBeInTheDocument();
    });
    expect(screen.queryByText('from-a')).not.toBeInTheDocument();
  });
});
