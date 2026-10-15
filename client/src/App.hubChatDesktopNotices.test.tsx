/**
 * App integration: OS notices for Hub Chat DMs and mentions come only from the
 * server's `notification_created` event, which carries the recipient's
 * desktop pref. The Hub Chat unread hook may raise a toast but never an OS
 * notice of its own.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, cleanup } from '@testing-library/react';

const ctl = vi.hoisted(() => ({
  resolveProjects: null as any,
  resolveSessionsByAgent: {} as Record<string, any>,
  wsHandler: null as any,
  hubChatOpts: null as any,
  notify: null as any,
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

// Capture the WS message handler App passes to useWebSocket.
(vi as any).mock('./hooks/useWebSocket.js', () => ({
  useWebSocket: (handler: any) => {
    ctl.wsHandler = handler;
    return { send: vi.fn(), connected: true, reconnecting: false, wsRef: { current: null } };
  },
}));
(vi as any).mock('./hooks/useDesktopNotifications.js', () => ({
  useDesktopNotifications: () => ({ notify: ctl.notify }),
}));
// Capture the Hub Chat notice callback so the test can fire a DM notice.
(vi as any).mock('./hooks/useHubChatUnread.js', () => ({
  useHubChatUnread: (opts: any) => {
    ctl.hubChatOpts = opts;
    return { badge: 0, channels: [] };
  },
}));
(vi as any).mock('./utils/notificationPrefsStore.js', () => ({
  loadNotificationPrefs: vi.fn(),
  isNotificationChannelEnabled: vi.fn(() => true),
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
import { NOTIFICATION_WS_EVENT } from './components/NotificationBell';

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
  await waitFor(() => expect(ctl.hubChatOpts?.onNotify).toBeTypeOf('function'));
}

const dmCreated = (desktop: boolean) => ({
  type: 'notification_created',
  desktop,
  notification: {
    id: 'n1',
    category: 'dm',
    title: 'bob',
    body: 'ping',
    data: { channelId: 'c1', messageId: 'm1' },
  },
});

describe('App: Hub Chat desktop notices', () => {
  const origElectron = globalThis.window.electronAPI;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    globalThis.window.electronAPI = undefined;
    mockFetch();
    ctl.resolveProjects = null;
    ctl.resolveSessionsByAgent = {};
    ctl.wsHandler = null;
    ctl.hubChatOpts = null;
    ctl.notify = vi.fn();
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    cleanup();
    globalThis.window.electronAPI = origElectron;
  });

  it('the Hub Chat notice path never raises an OS notice', async () => {
    await bootApp();
    await act(async () => {
      ctl.hubChatOpts.onNotify({
        channelId: 'c1',
        messageId: 'm1',
        title: 'bob',
        body: 'ping',
        category: 'dm',
      });
    });
    expect(ctl.notify).not.toHaveBeenCalled();
  });

  it('raises the DM notice from notification_created when desktop is on', async () => {
    await bootApp();
    const bell = vi.fn();
    window.addEventListener(NOTIFICATION_WS_EVENT, bell);
    await act(async () => {
      ctl.wsHandler(dmCreated(true));
    });
    window.removeEventListener(NOTIFICATION_WS_EVENT, bell);
    // The bell still gets the row.
    expect(bell).toHaveBeenCalledTimes(1);
    expect(ctl.notify).toHaveBeenCalledTimes(1);
    expect(ctl.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'bob', body: 'ping', category: 'dm' }),
    );
  });

  it('stays quiet when the recipient turned desktop off for DMs', async () => {
    await bootApp();
    await act(async () => {
      ctl.wsHandler(dmCreated(false));
    });
    expect(ctl.notify).not.toHaveBeenCalled();
  });
});
